import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type { Attachment } from '../agent/types';
import { getConfig } from '../config';
import { runCli } from './cli-runner';
import type {
  CollabArtifactType,
  CollabConfig,
  CollabEvent,
  CollabSessionRow,
  CollabTaskRow,
  CollabTaskView,
} from './types';
import {
  addArtifact,
  appendEvent,
  closeSessionsForNeckSession,
  createRun,
  createTask,
  ensureCollabSession,
  finishOpenRunsForTask,
  getArtifactForTask,
  getTask,
  getTaskView,
  recoverInterruptedCollabState,
  releaseWorkspaceLock,
  refreshWorkspaceLock,
  tryAcquireWorkspaceLock,
  updateRun,
  updateTask,
} from './store';

const execFile = promisify(execFileCb);
const emitter = new EventEmitter();
const controllers = new Map<string, AbortController>();
const MAX_COLLAB_EXECUTION_ATTEMPTS = 3;
const CLI_TIMEOUT_MS = 20 * 60 * 1000;
const CLI_MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
const WORKSPACE_LOCK_TTL_MS = 6 * 60 * 60 * 1000;
const ARTIFACT_READ_LIMIT = 1024 * 1024;

function truncate(text: string, max = 6000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function compact(text: unknown, max = 180): string {
  if (typeof text !== 'string') return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonLines(output: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) rows.push(parsed);
    } catch {
      // Ignore non-JSON log lines from CLI wrappers.
    }
  }
  return rows;
}

function event(input: Omit<CollabEvent, 'createdAt'>): CollabEvent {
  const persisted = appendEvent({ ...input, createdAt: Date.now() });
  emitter.emit('event', persisted);
  return persisted;
}

function artifactDir(workspaceRoot: string, sessionId: string, taskId: string): string {
  return join(workspaceRoot, '.neckcode', 'collab', 'sessions', sessionId, 'tasks', taskId);
}

async function writeArtifact(taskId: string, type: CollabArtifactType, path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content, 'utf8');
  registerArtifact(taskId, type, path);
}

function registerArtifact(taskId: string, type: CollabArtifactType, path: string): void {
  const artifact = addArtifact(taskId, type, path);
  const view = getTaskView(taskId);
  if (view) {
    event({
      sessionId: view.sessionId,
      collabSessionId: view.collabSessionId,
      taskId,
      agentRole: 'neck',
      type: 'artifact_written',
      phase: view.currentPhase,
      status: view.status,
      message: artifactLabel(type),
      artifactType: type,
      artifactPath: path,
      artifactId: artifact.id,
      payload: { artifactId: artifact.id, path },
    });
  }
}

async function writeStatusFile(session: CollabSessionRow, task: CollabTaskRow, dir: string): Promise<string> {
  const view = getTaskView(task.id);
  const path = join(dir, 'status.json');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(view || task, null, 2), 'utf8');
  registerArtifact(task.id, 'status', path);
  return path;
}

function artifactLabel(type: CollabArtifactType): string {
  const labels: Record<CollabArtifactType, string> = {
    brief: 'Codex 实现简报已生成',
    codex_plan_log: 'Codex 规划日志已保存',
    claude_log: 'Claude Code 执行日志已保存',
    result: 'Claude 执行摘要已生成',
    diff: '变更 diff 已生成',
    test_output: '验证输出已生成',
    codex_review_log: 'Codex 审查日志已保存',
    review: 'Codex 审查结果已生成',
    status: '协同任务状态已保存',
  };
  return labels[type] || '协同产物已生成';
}

function buildCodexPlanPrompt(userMessage: string, workspaceRoot: string, attachments: Attachment[]): string {
  const attachmentNote = attachments.length > 0
    ? `\nThe original user message included ${attachments.length} image attachment(s). Neck Code v1 does not forward images through this CLI pipeline; note this limitation if it matters.`
    : '';
  return [
    'You are the Codex Worker in Neck Code model collaboration mode.',
    'Your job is planning only. Do not edit files.',
    'Inspect the repository if needed and produce a concise implementation brief for Claude Code.',
    'The brief must include goal, relevant files, constraints, exact execution instructions, and verification steps.',
    'Use actual repository evidence over assumptions.',
    'Write the brief in Chinese.',
    '',
    `Workspace: ${workspaceRoot}`,
    '',
    'User request:',
    userMessage,
    attachmentNote,
  ].join('\n');
}

function buildClaudePrompt(brief: string): string {
  return [
    'You are the Claude Code Worker in Neck Code model collaboration mode.',
    'Execute the implementation described in the brief. Keep changes scoped.',
    'After editing, run the smallest meaningful verification you can identify.',
    'Return a concise Chinese result with changed files, verification, failures, and unresolved risks.',
    '',
    brief,
  ].join('\n');
}

function buildClaudeFixPrompt(brief: string, review: string, diff: string, testOutput: string): string {
  return [
    'You are the Claude Code Worker in Neck Code model collaboration mode.',
    'Codex reviewed the previous implementation and requested fixes.',
    'Apply only the concrete fixes that are relevant to the original task and the current workspace state.',
    'Keep changes scoped, then run the smallest meaningful verification again.',
    'Return a concise Chinese result with changed files, verification, failures, and unresolved risks.',
    '',
    'Implementation brief:',
    truncate(brief, 5000),
    '',
    'Codex review requiring fixes:',
    truncate(review, 6000),
    '',
    'Current git diff:',
    truncate(diff, 10000),
    '',
    'Latest verification output:',
    truncate(testOutput, 3000),
  ].join('\n');
}

function buildCodexReviewPrompt(
  userMessage: string,
  brief: string,
  claudeOutput: string,
  baselineDiff: string,
  baselineStatus: string,
  currentStatus: string,
  stagedDiff: string,
  diff: string,
  testOutput: string,
): string {
  return [
    'You are the Codex Worker in review mode for Neck Code model collaboration.',
    'Review the implementation. Do not edit files.',
    'Base your review on the actual diff and test output. Lead with bugs, regressions, risks, and missing tests.',
    'If the implementation is acceptable, say APPROVED. If follow-up is required, say NEEDS_FIX and list concrete fixes.',
    'Write the review in Chinese, but keep the APPROVED or NEEDS_FIX marker exactly as English.',
    'Important: the workspace may have had pre-existing changes before this collaboration task. Do not request fixes for pre-existing diff unless the current task made it worse.',
    'If the user requested an output outside the git workspace, absence from git diff is not automatically a bug; use the execution and verification output.',
    '',
    'Original user request:',
    userMessage,
    '',
    'Implementation brief:',
    truncate(brief, 4000),
    '',
    'Claude execution output:',
    truncate(claudeOutput, 4000),
    '',
    'Pre-existing git diff before this collaboration task (ignore this as baseline):',
    truncate(baselineDiff || 'No pre-existing diff.', 8000),
    '',
    'Pre-existing git status before this collaboration task:',
    truncate(baselineStatus || 'No pre-existing status.', 4000),
    '',
    'Current git status after Claude execution:',
    truncate(currentStatus || 'No current git status output.', 4000),
    '',
    'Current staged diff after Claude execution:',
    truncate(stagedDiff || 'No staged diff.', 8000),
    '',
    'Current git diff after Claude execution:',
    truncate(diff, 12000),
    '',
    'Test output:',
    truncate(testOutput, 4000),
  ].join('\n');
}

function toolLabel(name: string, input: unknown): string {
  const data = isRecord(input) ? input : {};
  const file = compact(data.file_path || data.path || data.notebook_path || data.relative_path, 90);
  const description = compact(data.description, 120);
  if (name === 'PowerShell' || name === 'Bash') return description || '运行终端命令';
  if (name === 'Read') return file ? `读取文件 ${file}` : '读取文件';
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') return file ? `修改文件 ${file}` : '修改文件';
  if (name === 'Glob' || name === 'Grep') return compact(data.pattern || data.query, 90) || '检索代码';
  if (name === 'TodoWrite') return '更新任务清单';
  if (name === 'Task') return compact(data.description, 120) || '启动子任务';
  if (name === 'AskUserQuestion') return '等待用户确认';
  return name;
}

function summarizeCliLine(agentRole: 'codex' | 'claude', phase: string, line: string, parsed?: Record<string, unknown>): { type: string; message: string; payload?: Record<string, unknown> } | null {
  if (!parsed) {
    const text = compact(line, 160);
    return text ? { type: 'status', message: text } : null;
  }

  if (agentRole === 'claude') {
    const type = String(parsed.type || '');
    if (type === 'system' && parsed.subtype === 'init') {
      return { type: 'status', message: `Claude Code 已启动：${String(parsed.model || '默认模型')}` };
    }
    const message = isRecord(parsed.message) ? parsed.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use') {
        const name = String(block.name || 'tool');
        return {
          type: 'tool_started',
          message: `Claude Code：${toolLabel(name, block.input)}`,
          payload: { toolName: name, summary: toolLabel(name, block.input) },
        };
      }
      if (block.type === 'text') {
        const text = compact(block.text, 180);
        if (text) return { type: 'output', message: `Claude Code：${text}` };
      }
      if (block.type === 'thinking') {
        return { type: 'status', message: 'Claude Code 正在分析实现步骤。' };
      }
    }
    if (type === 'result') return { type: 'status', message: 'Claude Code 执行阶段完成。' };
    return null;
  }

  const type = String(parsed.type || '');
  if (type === 'thread.started') return { type: 'status', message: phase === 'reviewing_codex' ? 'Codex 已开始审查。' : 'Codex 已开始规划。' };
  if (type === 'turn.started') return { type: 'status', message: phase === 'reviewing_codex' ? 'Codex 正在读取 diff 和验证结果。' : 'Codex 正在整理实现简报。' };
  if (type === 'item.completed' && isRecord(parsed.item)) {
    const item = parsed.item;
    if (item.type === 'agent_message') {
      const text = compact(item.text, 180);
      return text ? { type: 'output', message: `Codex：${text}` } : null;
    }
    if (item.type === 'tool_call') {
      const name = String(item.name || item.tool_name || 'tool');
      return { type: 'tool_started', message: `Codex：${toolLabel(name, item.arguments)}`, payload: { toolName: name } };
    }
  }
  if (type === 'turn.completed') return { type: 'status', message: phase === 'reviewing_codex' ? 'Codex 审查完成。' : 'Codex 规划完成。' };
  return null;
}

function summarizeClaudeOutput(output: string): string {
  const tools: string[] = [];
  const texts: string[] = [];
  for (const parsed of jsonLines(output)) {
    const message = isRecord(parsed.message) ? parsed.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_use') {
        const name = String(block.name || 'tool');
        const label = toolLabel(name, block.input);
        if (label && !tools.includes(label)) tools.push(label);
      } else if (block.type === 'text') {
        const text = compact(block.text, 240);
        if (text) texts.push(text);
      }
    }
    if (typeof parsed.result === 'string') {
      const text = compact(parsed.result, 300);
      if (text) texts.push(text);
    }
  }
  const lines = ['Claude Code 已完成执行。'];
  if (tools.length > 0) lines.push(`执行动作：${tools.slice(0, 6).join('；')}${tools.length > 6 ? '；...' : ''}`);
  if (texts.length > 0) lines.push(`输出摘要：${texts.slice(-2).join(' ')}`);
  return lines.join('\n');
}

function summarizeReview(review: string, approved: boolean): string {
  const cleaned = review.replace(/\b(APPROVED|NEEDS_FIX)\b/gi, '').trim();
  const hasChinese = /[\u4e00-\u9fff]/.test(cleaned);
  if (approved) {
    return hasChinese && cleaned ? `结论：通过。\n${truncate(cleaned, 1200)}` : '结论：通过。';
  }
  return hasChinese && cleaned
    ? `结论：仍需修复。\n${truncate(cleaned, 1400)}`
    : '结论：仍需修复。详细审查记录已保存到 review.md。';
}

function summarizeTestOutput(output: string): string {
  const text = output.trim();
  if (!text) return '未产生验证输出。';
  if (/No npm test script configured/i.test(text)) return '当前项目未配置 npm test 脚本。';
  if (/^ERROR:/i.test(text)) return `验证失败：${truncate(text.replace(/^ERROR:\s*/i, ''), 1200)}`;
  return truncate(text, 1200);
}

async function getGitDiff(workspaceRoot: string): Promise<string> {
  try {
    const result = await execFile('git', ['diff', '--binary'], {
      cwd: workspaceRoot,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout || '';
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return [error.stdout, error.stderr, error.message].filter(Boolean).join('\n') || 'git diff failed';
  }
}

async function getGitStagedDiff(workspaceRoot: string): Promise<string> {
  try {
    const result = await execFile('git', ['diff', '--cached', '--binary'], {
      cwd: workspaceRoot,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout || '';
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return [error.stdout, error.stderr, error.message].filter(Boolean).join('\n') || 'git staged diff failed';
  }
}

async function getGitStatus(workspaceRoot: string): Promise<string> {
  try {
    const result = await execFile('git', ['status', '--short', '--untracked-files=all'], {
      cwd: workspaceRoot,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return result.stdout || '';
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return [error.stdout, error.stderr, error.message].filter(Boolean).join('\n') || 'git status failed';
  }
}

async function runTestsIfConfigured(workspaceRoot: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await fs.readFile(join(workspaceRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = packageJson.scripts?.test;
    if (!script || /no test specified/i.test(script)) {
      return 'No npm test script configured.';
    }
    const result = await execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], {
      cwd: workspaceRoot,
      timeout: 120_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return [result.stdout, result.stderr].filter(Boolean).join('\n') || 'npm test completed with no output.';
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return `ERROR: ${[error.message, error.stdout, error.stderr].filter(Boolean).join('\n')}`;
  }
}

async function acquireWorkspaceLock(workspaceRoot: string, task: CollabTaskRow, session: CollabSessionRow, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (tryAcquireWorkspaceLock(workspaceRoot, task.id, WORKSPACE_LOCK_TTL_MS)) {
      event({
        sessionId: session.neck_session_id,
        collabSessionId: session.id,
        taskId: task.id,
        agentRole: 'neck',
        type: 'lock_acquired',
        phase: 'executing_claude',
        status: 'running',
        message: '已获得工作区写入锁。',
      });
      return;
    }
    event({
      sessionId: session.neck_session_id,
      collabSessionId: session.id,
      taskId: task.id,
      agentRole: 'neck',
      type: 'lock_waiting',
      phase: 'executing_claude',
      status: 'running',
      message: '正在等待工作区写入锁。',
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('等待工作区写入锁时已取消。');
}

async function withWorkspaceLock<T>(
  workspaceRoot: string,
  task: CollabTaskRow,
  session: CollabSessionRow,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireWorkspaceLock(workspaceRoot, task, session, signal);
  const heartbeat = setInterval(() => {
    refreshWorkspaceLock(workspaceRoot, task.id, WORKSPACE_LOCK_TTL_MS);
  }, 30_000);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    releaseWorkspaceLock(workspaceRoot, task.id);
  }
}

function codexArgs(config: CollabConfig, model: string, workspaceRoot: string, outputPath: string): string[] {
  const args = [
    'exec',
    '--cd', workspaceRoot,
    '--sandbox', 'read-only',
    '--json',
    '--output-last-message', outputPath,
  ];
  if (model) args.push('--model', model);
  if (config.codexEffort) args.push('--config', `model_reasoning_effort="${config.codexEffort}"`);
  args.push('-');
  return args;
}

function claudeArgs(config: CollabConfig): string[] {
  const args = [
    '-p',
    '--verbose',
    '--input-format', 'text',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--allowed-tools', 'Read,Edit,Bash',
    '--effort', 'max',
  ];
  if (config.claudeModel) args.push('--model', config.claudeModel);
  return args;
}

export function onCollabEvent(listener: (event: CollabEvent) => void): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

export function recoverCollabRuntime(): void {
  for (const recovered of recoverInterruptedCollabState()) {
    emitter.emit('event', recovered);
  }
}

export async function readCollabArtifact(taskId: string, artifactId: string): Promise<{
  artifact: { id: string; type: CollabArtifactType; path: string; createdAt: number };
  content: string;
  truncated: boolean;
}> {
  const artifact = getArtifactForTask(taskId, artifactId);
  if (!artifact) throw new Error('Collaboration artifact not found.');
  const stat = await fs.stat(artifact.path);
  const truncated = stat.size > ARTIFACT_READ_LIMIT;
  let content: string;
  if (truncated) {
    const handle = await fs.open(artifact.path, 'r');
    try {
      const buffer = Buffer.alloc(ARTIFACT_READ_LIMIT);
      const result = await handle.read(buffer, 0, ARTIFACT_READ_LIMIT, 0);
      content = buffer.subarray(0, result.bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } else {
    content = await fs.readFile(artifact.path, 'utf8');
  }
  return {
    artifact: {
      id: artifact.id,
      type: artifact.type,
      path: artifact.path,
      createdAt: artifact.created_at,
    },
    content,
    truncated,
  };
}

export async function runCollabTask(params: {
  sessionId: string;
  userMessage: string;
  attachments: Attachment[];
  workspaceRoot: string;
  config: CollabConfig;
  signal?: AbortSignal;
}): Promise<{ task: CollabTaskView | undefined; finalText: string }> {
  const session = ensureCollabSession(params.sessionId, params.workspaceRoot);
  const task = createTask(session.id, params.userMessage);
  const ctrl = new AbortController();
  controllers.set(task.id, ctrl);
  params.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  const signal = ctrl.signal;
  const dir = artifactDir(params.workspaceRoot, params.sessionId, task.id);
  await fs.mkdir(dir, { recursive: true });

  event({
    sessionId: params.sessionId,
    collabSessionId: session.id,
    taskId: task.id,
    agentRole: 'neck',
    type: 'task_created',
    phase: 'created',
    status: 'created',
    message: 'Collaboration task created.',
  });

  try {
    const neckRun = createRun(task.id, 'neck', 'Neck Code orchestrator', 'Neck Code');
    event({
      sessionId: params.sessionId,
      collabSessionId: session.id,
      taskId: task.id,
      runId: neckRun.id,
      agentRole: 'neck',
      type: 'run_started',
      phase: 'created',
      status: 'running',
      model: 'Neck Code',
      message: 'Packaging context and dispatching Codex planner.',
    });
    updateRun(neckRun.id, 'completed');
    const baselineDiff = await getGitDiff(params.workspaceRoot);
    const baselineStatus = await getGitStatus(params.workspaceRoot);

    updateTask(task.id, 'planning_codex');
    const briefPath = join(dir, 'brief.md');
    const codexPlanLog = join(dir, 'codex-plan.jsonl');
    const planRun = createRun(task.id, 'codex', params.config.codexCommand, params.config.codexModel || 'default');
    event({
      sessionId: params.sessionId,
      collabSessionId: session.id,
      taskId: task.id,
      runId: planRun.id,
      agentRole: 'codex',
      type: 'run_started',
      phase: 'planning_codex',
      status: 'running',
      model: params.config.codexModel || 'default',
      message: 'Codex is preparing the implementation brief.',
    });
    const planResult = await runCli({
      command: params.config.codexCommand,
      args: codexArgs(params.config, params.config.codexModel, params.workspaceRoot, briefPath),
      cwd: params.workspaceRoot,
      logPath: codexPlanLog,
      input: buildCodexPlanPrompt(params.userMessage, params.workspaceRoot, params.attachments),
      signal,
      timeoutMs: CLI_TIMEOUT_MS,
      maxOutputBytes: CLI_MAX_OUTPUT_BYTES,
      onLine(line, parsed) {
        const summary = summarizeCliLine('codex', 'planning_codex', line, parsed);
        if (!summary) return;
        event({
          sessionId: params.sessionId,
          collabSessionId: session.id,
          taskId: task.id,
          runId: planRun.id,
          agentRole: 'codex',
          type: summary.type,
          phase: 'planning_codex',
          status: 'running',
          model: params.config.codexModel || 'default',
          message: summary.message,
          payload: summary.payload,
        });
      },
    });
    registerArtifact(task.id, 'codex_plan_log', codexPlanLog);
    if (planResult.exitCode !== 0) {
      updateRun(planRun.id, signal.aborted ? 'cancelled' : 'failed');
      throw new Error(`Codex planning failed with exit code ${planResult.exitCode}: ${planResult.errorOutput || planResult.output}`);
    }
    let brief = await fs.readFile(briefPath, 'utf8').catch(() => planResult.output || buildCodexPlanPrompt(params.userMessage, params.workspaceRoot, params.attachments));
    if (!brief.trim()) {
      brief = buildCodexPlanPrompt(params.userMessage, params.workspaceRoot, params.attachments);
      await writeArtifact(task.id, 'brief', briefPath, brief);
    } else {
      registerArtifact(task.id, 'brief', briefPath);
    }
    updateRun(planRun.id, 'completed');
    updateTask(task.id, 'planned');

    let approved = false;
    let attemptUsed = 0;
    let finalClaudeSummary = 'Claude Code 未产生可读摘要。';
    let review = '';
    let testOutput = '';
    let diff = '';

    for (let attempt = 1; attempt <= MAX_COLLAB_EXECUTION_ATTEMPTS; attempt += 1) {
      attemptUsed = attempt;
      const suffix = attempt === 1 ? '' : `-attempt-${attempt}`;
      updateTask(task.id, 'executing_claude');
      if (attempt > 1) {
        event({
          sessionId: params.sessionId,
          collabSessionId: session.id,
          taskId: task.id,
          agentRole: 'neck',
          type: 'retry_started',
          phase: 'executing_claude',
          status: 'running',
          message: `Codex 要求修复，开始第 ${attempt} 轮执行。`,
        });
      }
      const claudeResult = await withWorkspaceLock(params.workspaceRoot, task, session, signal, async () => {
      const claudeLog = join(dir, `claude-output${suffix}.jsonl`);
      const resultPath = join(dir, `result${suffix}.md`);
      const claudeRun = createRun(task.id, 'claude', params.config.claudeCommand, params.config.claudeModel);
      event({
        sessionId: params.sessionId,
        collabSessionId: session.id,
        taskId: task.id,
        runId: claudeRun.id,
        agentRole: 'claude',
        type: 'run_started',
        phase: 'executing_claude',
        status: 'running',
        model: params.config.claudeModel,
        message: attempt === 1 ? 'Claude Code 开始执行实现。' : `Claude Code 开始第 ${attempt} 轮修复。`,
      });
      const result = await runCli({
        command: params.config.claudeCommand,
        args: claudeArgs(params.config),
        cwd: params.workspaceRoot,
        logPath: claudeLog,
        input: attempt === 1 ? buildClaudePrompt(brief) : buildClaudeFixPrompt(brief, review, diff, testOutput),
        signal,
        timeoutMs: CLI_TIMEOUT_MS,
        maxOutputBytes: CLI_MAX_OUTPUT_BYTES,
        onLine(line, parsed) {
          const summary = summarizeCliLine('claude', 'executing_claude', line, parsed);
          if (!summary) return;
          event({
            sessionId: params.sessionId,
            collabSessionId: session.id,
            taskId: task.id,
            runId: claudeRun.id,
            agentRole: 'claude',
            type: summary.type,
            phase: 'executing_claude',
            status: 'running',
            model: params.config.claudeModel,
            message: summary.message,
            payload: summary.payload,
          });
        },
      });
      registerArtifact(task.id, 'claude_log', claudeLog);
      finalClaudeSummary = summarizeClaudeOutput(result.output || result.errorOutput || '');
      await writeArtifact(task.id, 'result', resultPath, finalClaudeSummary);
      if (result.exitCode !== 0) {
        updateRun(claudeRun.id, signal.aborted ? 'cancelled' : 'failed');
        throw new Error(`Claude execution failed with exit code ${result.exitCode}: ${result.errorOutput || result.output}`);
      }
      updateRun(claudeRun.id, 'completed');
      return result;
      });
      updateTask(task.id, 'executed');

      const diffPath = join(dir, `diff${suffix}.patch`);
      diff = await getGitDiff(params.workspaceRoot);
      const currentStatus = await getGitStatus(params.workspaceRoot);
      const stagedDiff = await getGitStagedDiff(params.workspaceRoot);
      await writeArtifact(task.id, 'diff', diffPath, diff || 'No git diff.');
      const testPath = join(dir, `test-output${suffix}.log`);
      testOutput = await runTestsIfConfigured(params.workspaceRoot);
      await writeArtifact(task.id, 'test_output', testPath, testOutput);

      updateTask(task.id, 'reviewing_codex');
      const reviewPath = join(dir, `review${suffix}.md`);
      const codexReviewLog = join(dir, `codex-review${suffix}.jsonl`);
      const reviewRun = createRun(task.id, 'codex', params.config.codexCommand, params.config.codexModel || 'default');
      event({
        sessionId: params.sessionId,
        collabSessionId: session.id,
        taskId: task.id,
        runId: reviewRun.id,
        agentRole: 'codex',
        type: 'run_started',
        phase: 'reviewing_codex',
        status: 'running',
        model: params.config.codexModel || 'default',
        message: 'Codex 开始审查实际变更和验证结果。',
      });
      const reviewResult = await runCli({
        command: params.config.codexCommand,
        args: codexArgs(params.config, params.config.codexModel, params.workspaceRoot, reviewPath),
        cwd: params.workspaceRoot,
        logPath: codexReviewLog,
        input: buildCodexReviewPrompt(params.userMessage, brief, claudeResult.output, baselineDiff, baselineStatus, currentStatus, stagedDiff, diff, testOutput),
        signal,
        timeoutMs: CLI_TIMEOUT_MS,
        maxOutputBytes: CLI_MAX_OUTPUT_BYTES,
        onLine(line, parsed) {
          const summary = summarizeCliLine('codex', 'reviewing_codex', line, parsed);
          if (!summary) return;
          event({
            sessionId: params.sessionId,
            collabSessionId: session.id,
            taskId: task.id,
            runId: reviewRun.id,
            agentRole: 'codex',
            type: summary.type,
            phase: 'reviewing_codex',
            status: 'running',
            model: params.config.codexModel || 'default',
            message: summary.message,
            payload: summary.payload,
          });
        },
      });
      registerArtifact(task.id, 'codex_review_log', codexReviewLog);
      if (reviewResult.exitCode !== 0) {
        updateRun(reviewRun.id, signal.aborted ? 'cancelled' : 'failed');
        throw new Error(`Codex review failed with exit code ${reviewResult.exitCode}: ${reviewResult.errorOutput || reviewResult.output}`);
      }
      review = await fs.readFile(reviewPath, 'utf8').catch(() => reviewResult.output || '');
      if (!review.trim()) {
        review = reviewResult.output || 'Codex review produced no output.';
        await writeArtifact(task.id, 'review', reviewPath, review);
      } else {
        registerArtifact(task.id, 'review', reviewPath);
      }
      const reviewText = review || reviewResult.output || '';
      const needsFix = /\bNEEDS_FIX\b/i.test(reviewText);
      approved = /\bAPPROVED\b/i.test(reviewText) && !needsFix;
      updateRun(reviewRun.id, 'completed');
      if (approved || attempt === MAX_COLLAB_EXECUTION_ATTEMPTS) {
        updateTask(task.id, approved ? 'approved' : 'needs_fix', approved ? 'approved' : 'needs_fix');
        break;
      }
      updateTask(task.id, 'needs_fix', 'needs_fix');
      event({
        sessionId: params.sessionId,
        collabSessionId: session.id,
        taskId: task.id,
        agentRole: 'neck',
        type: 'review_needs_fix',
        phase: 'needs_fix',
        status: 'needs_fix',
        message: `Codex 要求继续修复，将进入第 ${attempt + 1} 轮。`,
      });
    }

    await writeStatusFile(session, task, dir);

    const finalText = [
      approved ? '模型协同任务已完成，Codex 审查通过。' : '模型协同已完成自动返工，但 Codex 仍要求继续修复。',
      '',
      `任务 ID: ${task.id}`,
      `执行轮次：${attemptUsed}`,
      '',
      '## Claude 执行摘要',
      finalClaudeSummary,
      '',
      '## Codex 审查',
      summarizeReview(review, approved),
      '',
      '## 验证',
      summarizeTestOutput(testOutput),
    ].join('\n');
    event({
      sessionId: params.sessionId,
      collabSessionId: session.id,
      taskId: task.id,
      agentRole: 'neck',
      type: 'task_completed',
      phase: approved ? 'approved' : 'needs_fix',
      status: approved ? 'approved' : 'needs_fix',
      message: approved ? '协同任务审查通过。' : '协同任务已达到自动修复轮次上限，仍需人工确认。',
    });
    return { task: getTaskView(task.id), finalText };
  } catch (err) {
    releaseWorkspaceLock(params.workspaceRoot, task.id);
    const aborted = signal.aborted;
    finishOpenRunsForTask(task.id, aborted ? 'cancelled' : 'failed');
    updateTask(task.id, aborted ? 'cancelled' : 'failed', aborted ? 'cancelled' : 'failed');
    await writeStatusFile(session, task, dir).catch(() => {});
    event({
      sessionId: params.sessionId,
      collabSessionId: session.id,
      taskId: task.id,
      agentRole: 'neck',
      type: aborted ? 'task_cancelled' : 'task_failed',
      phase: aborted ? 'cancelled' : 'failed',
      status: aborted ? 'cancelled' : 'failed',
      message: err instanceof Error ? err.message : String(err),
    });
    const finalText = [
      aborted ? '模型协同任务已取消。' : '模型协同任务失败。',
      '',
      `任务 ID: ${task.id}`,
      '',
      err instanceof Error ? err.message : String(err),
    ].join('\n');
    return { task: getTaskView(task.id), finalText };
  } finally {
    controllers.delete(task.id);
  }
}

export function abortCollabTask(taskId: string): void {
  controllers.get(taskId)?.abort();
  const task = getTask(taskId);
  if (task) {
    finishOpenRunsForTask(task.id, 'cancelled');
    updateTask(task.id, 'cancelled', 'cancelled');
  }
}

export function approveCollabTask(taskId: string): CollabTaskView | undefined {
  updateTask(taskId, 'approved', 'approved');
  const view = getTaskView(taskId);
  if (view) {
    event({
      sessionId: view.sessionId,
      collabSessionId: view.collabSessionId,
      taskId,
      agentRole: 'neck',
      type: 'task_approved',
      phase: 'approved',
      status: 'approved',
      message: '任务已手动通过。',
    });
  }
  return view;
}

export async function retryCollabTask(taskId: string, phase?: string): Promise<CollabTaskView | undefined> {
  const view = getTaskView(taskId);
  if (!view) return undefined;
  const cfg = getConfig();
  const result = await runCollabTask({
    sessionId: view.sessionId,
    userMessage: `${view.userMessage}\n\n[Retry requested for phase: ${phase || view.currentPhase}]`,
    attachments: [],
    workspaceRoot: cfg.agent.workspaceRoot,
    config: cfg.collab,
  });
  return result.task;
}

export function closeCollabForSession(sessionId: string): void {
  for (const [taskId, ctrl] of controllers) {
    const view = getTaskView(taskId);
    if (view?.sessionId === sessionId) ctrl.abort();
  }
  closeSessionsForNeckSession(sessionId);
}
