import { ipcMain, BrowserWindow, dialog } from 'electron';
import { promises as fs } from 'fs';
import { dirname, resolve, join } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { AgentRuntime, type Provider } from './agent/runtime';
import type { ToolRegistry } from './agent/runtime';
import type { Attachment, ContextStatus, Message, QueuedUserMessage, ToolCall } from './agent/types';
import { BLOCKING_BUFFER_TOKENS, MAX_RESERVED_OUTPUT_TOKENS, getAutoCompactThreshold } from './agent/context-manager';
import { getConfig, setConfig, saveConfig, getActiveProvider, getAllModelNames, getModelConfig, inferModelMode, getAgents, saveAgent, deleteAgent } from './config';
import type { AppConfigData, ProviderConfig } from './config';
import type { PermissionMode } from '../shared/permissions';
import type { AgentConfig, AgentError, AgentErrorCode, ProviderTestCheck, ProviderTestConfig, ProviderTestResult, RunStatusEvent } from '../shared/types';
import { discoverAgentMd } from './agent-md';
import { getLoadedSkills, loadSkills } from './skills/loader';
import {
  deleteSession,
  listSessions,
  loadSession,
  listSessionGroups,
  createSessionGroup,
  renameSessionGroup,
  renameSession,
  saveSession,
  setSessionGroup,
  setSessionGroupCollapsed,
  setSessionGroupPinned,
  setSessionPinned,
  deleteSessionGroup,
  type SessionData,
} from './session-store';
import { getQuickLauncherWindow, syncQuickLauncherTheme } from './quick-launcher/window';
import { setPetState, sayPet } from './pet-window';
import { isPlanMode, enterPlanMode, exitPlanMode } from './plan-mode';
import {
  shouldExtractMemory,
  extractSessionMemory,
  getSessionMemoryContent,
  getLayeredMemoryContent,
  getCachedLayeredMemoryContent,
  preloadLayeredMemoryContent,
} from './session-memory';
import { APP_DATA_DIR_NAME, LEGACY_APP_DATA_DIR_NAME, legacyUserDataDir, userDataDir } from './app-paths';
import { addToTotalSessionCost, calculateUSDCost, getCostSummary, resetCostState, getCostStateSnapshot, restoreCostState, type StoredCostState } from './cost-tracker';
import { triggerHooks, triggerHooksSync } from './hooks';
import { listTasksSnapshot, onTasksChanged } from './tools/task-tools';
import { normalizeCollabConfig } from './collab/config';
import { checkCollabCli } from './collab/check';
import { abortCollabTask, approveCollabTask, closeCollabForSession, onCollabEvent, retryCollabTask, runCollabTask } from './collab/orchestrator';
import { getSessionStatus as getCollabSessionStatus, listTaskViews as listCollabTaskViews } from './collab/store';

let agentMdContent = '';
let agentMdFiles: string[] = [];

// Pending UI promises, keyed by unique IDs and tied to the originating session.
export const pendingAsks = new Map<string, { sessionId: string; resolve: (answers: Record<string, string>) => void; reject: (err: Error) => void }>();
export const pendingConfirms = new Map<string, { sessionId: string; resolve: (approved: boolean) => void; reject: (err: Error) => void }>();

const sessionAgents = new Map<string, AgentRuntime>();
const sessionAbortControllers = new Map<string, AbortController>();
const sessionRunningTurns = new Map<string, Promise<unknown>>();
const sessionQueuedTurns = new Map<string, QueuedUserMessage[]>();
const sessionModels = new Map<string, string>();
/** Persist compactCount across session agent recreations (e.g. when switching conversations). */
const sessionCompactMeta = new Map<string, { compactCount: number; lastCompactAt: number | null }>();
const QUICK_CHAT_SESSION_ID = '__quick_chat_ephemeral__';
let activePetSession: string | null = null; // track which session controls the pet
const quickChatEntries: Array<Record<string, unknown>> = [];
let quickChatSavedSessionId: string | null = null;

let currentPermissionMode: PermissionMode = getConfig().permissionMode || 'default';

export function getPermissionMode(): PermissionMode {
  currentPermissionMode = getConfig().permissionMode || currentPermissionMode || 'default';
  if (currentPermissionMode === 'plan') {
    enterPlanMode();
  }
  return currentPermissionMode;
}

function buildSkillsPrompt(): string {
  const skills = getLoadedSkills();
  const available = skills.filter(s => !s.disableModelInvocation && s.userInvocable !== false);
  if (available.length === 0) return '';

  const lines = ['## Available Skills'];
  lines.push('');
  lines.push('You have access to the following skills. When a user request matches a skill\'s trigger conditions, you MUST proactively invoke the relevant skill using the `invoke_skill` tool before responding. Use `list_skills` to see full skill details including when-to-use hints.');
  lines.push('');
  lines.push('**Neck Code skill storage**: All skills, memory, and config live under `~/.neckcode/`. When creating or editing skills, write to `~/.neckcode/skills/<name>/SKILL.md`. Do NOT use `~/.claude/` paths — that is a different application.');

  for (const s of available) {
    const trigger = s.whenToUse ? ` TRIGGER when: ${s.whenToUse}` : '';
    const hint = s.argumentHint ? ` Args: ${s.argumentHint}` : '';
    lines.push(`\n### ${s.name}\n${s.description}${trigger}${hint}`);
  }

  return lines.join('\n');
}

function summarizeAgentMemory(memory: string): string {
  const normalized = memory.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'No specialization notes provided.';
  return normalized.length > 220 ? `${normalized.slice(0, 220)}...` : normalized;
}

function buildAgentsPrompt(): string {
  const agents = getAgents().filter(agent => (agent.name.trim() || agent.id.trim()) && agent.model.trim());
  if (agents.length === 0) return '';

  const lines = ['## Available Agents'];
  lines.push('');
  lines.push('You can delegate work to configured specialist agents with the `invoke_agent` tool.');
  lines.push('Use `invoke_agent` proactively when a listed agent is a better fit for the task, when a separate context would help, or when an independent subtask can be delegated cleanly.');
  lines.push('When delegating, pass the exact agent name or ID and make the `task` self-contained with the user goal, relevant files, constraints, and expected output.');
  lines.push('If the current user turn contains image attachments, `invoke_agent` automatically forwards those images to the sub-agent.');
  lines.push('If no listed agent clearly fits, solve the task yourself.');

  for (const agent of agents) {
    const title = agent.name.trim() || agent.id;
    lines.push('');
    lines.push(`### ${title}`);
    lines.push(`ID: ${agent.id}`);
    lines.push(`Model: ${agent.model}`);
    if (agent.skills.length > 0) {
      lines.push(`Skills: ${agent.skills.join(', ')}`);
    }
    lines.push(`Specialization: ${summarizeAgentMemory(agent.memory)}`);
  }

  return lines.join('\n');
}

function buildFullPrompt(): string {
  const cfg = getConfig();
  const parts = [cfg.systemPrompt];
  const workspaceRoot = cfg.agent.workspaceRoot;
  const layeredMemory = getCachedLayeredMemoryContent(workspaceRoot);
  if (!layeredMemory.project && !layeredMemory.user) {
    void preloadLayeredMemoryContent(workspaceRoot).catch(() => {});
  }
  // Project & user memory are static config — safe to inject.
  if (layeredMemory.project) parts.push('## Project Memory\n\n' + layeredMemory.project);
  if (layeredMemory.user) parts.push('## User Preferences Memory\n\n' + layeredMemory.user);
  // Session memory is NOT injected here — it grows dynamically and
  // would bloat every API call. The model already has conversation history.
  if (agentMdContent) parts.push(agentMdContent);
  const skillsPrompt = buildSkillsPrompt();
  if (skillsPrompt) parts.push(skillsPrompt);
  const agentsPrompt = buildAgentsPrompt();
  if (agentsPrompt) parts.push(agentsPrompt);
  return parts.join('\n\n');
}

let _mainWindow: import('electron').BrowserWindow | null = null;
export function setMainWindow(win: import('electron').BrowserWindow) { _mainWindow = win; }

function getWindow() {
  return _mainWindow && !_mainWindow.isDestroyed() ? _mainWindow : null;
}

function requestWindowAttention(): void {
  const win = getWindow();
  if (!win) return;
  if (win.isFocused() && !win.isMinimized() && win.isVisible()) return;
  win.flashFrame(true);
  setTimeout(() => {
    try { win.flashFrame(false); } catch {}
  }, 12000);
  win.once('focus', () => {
    try { win.flashFrame(false); } catch {}
  });
}

function emitRunStatus(sessionId: string, status: RunStatusEvent): void {
  // Sync pet state with agent phase (deduplicated, streaming skipped)
  const phase = status.phase;
  const tool = (status.currentTool || status.lastTool || '');
  if (phase !== 'streaming' && phase !== 'requesting_model') {
    if (phase === 'starting') {
      setPetState('thinking'); sayPet('\uD83D\uDCAD Thinking...');
    } else if (phase === 'tool_running') {
      const label = tool || 'Working';
      if (tool === 'write_file' || tool === 'edit_file') { setPetState('working'); sayPet('\u270F\uFE0F ' + label); }
      else if (tool === 'run_shell') { setPetState('carrying'); sayPet('\u2699\uFE0F ' + label); }
      else if (tool.startsWith('mcp__')) { setPetState('carrying'); sayPet('\uD83D\uDD17 MCP: ' + tool.replace('mcp__', '').split('__')[0]); }
      else if (tool === 'task_create' || tool === 'task_update') { setPetState('building'); sayPet('\uD83D\uDCCB ' + label); }
      else if (tool === 'read_file' || tool === 'glob' || tool === 'grep' || tool === 'web_fetch' || tool === 'web_search') { setPetState('thinking'); sayPet('\uD83D\uDD0D ' + label); }
      else { setPetState('working'); sayPet('\uD83D\uDD27 ' + label); }
    } else if (phase === 'finishing') {
      setPetState('attention'); sayPet('\u2705 Done');
    } else if (phase === 'error') {
      setPetState('error'); sayPet('\u274C Error');
    } else if (phase === 'aborted') {
      setPetState('idle');
    }
  }

  getWindow()?.webContents.send('agent:run-status', sessionId, {
    ...status,
    lastEventAt: status.lastEventAt || Date.now(),
  });
}

function emitQueuedCount(sessionId: string): void {
  getWindow()?.webContents.send('agent:queued-count', sessionId, sessionQueuedTurns.get(sessionId)?.length || 0);
}

  function emitQueuedMessageStart(sessionId: string, message: QueuedUserMessage): void {
  getWindow()?.webContents.send('agent:queued-message-start', sessionId, message);
}

function enqueueQueuedTurn(sessionId: string, message: string, attachments: Attachment[]): QueuedUserMessage {
  const queued: QueuedUserMessage = {
    id: `queued_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    content: message,
    attachments,
  };
  const queue = sessionQueuedTurns.get(sessionId) || [];
  queue.push(queued);
  sessionQueuedTurns.set(sessionId, queue);
  emitQueuedCount(sessionId);
  return queued;
}

function normalizeAttachments(attachments: Array<{ type: string; data: string; mimeType: string }> = []): Attachment[] {
  return attachments
    .filter(att => att.type === 'image')
    .map(att => ({ type: 'image', data: att.data, mimeType: att.mimeType }));
}

function takeQueuedTurn(sessionId: string): QueuedUserMessage | null {
  const queue = sessionQueuedTurns.get(sessionId);
  const queued = queue?.shift() || null;
  if (queue && queue.length === 0) sessionQueuedTurns.delete(sessionId);
  emitQueuedCount(sessionId);
  return queued;
}

function clearQueuedTurns(sessionId: string): void {
  if (!sessionQueuedTurns.has(sessionId)) return;
  sessionQueuedTurns.delete(sessionId);
  emitQueuedCount(sessionId);
}

function normalizeOpenAIBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/(chat\/completions|completions|v1)\/?$/, '');
}

function classifyAgentError(error: unknown): AgentError {
  const cfg = getConfig();
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  let code: AgentErrorCode = 'unknown';
  let suggestion = '请复制错误信息后重试；如果持续出现，检查 Provider 配置和网络连接。';
  let retryable = false;

  if (lower.includes('aborted') || lower.includes('aborterror')) {
    code = 'aborted';
    suggestion = '任务已中断。';
  } else if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('api key')) {
    code = 'auth_error';
    suggestion = '检查 API Key 是否正确、是否过期，以及当前 Provider 是否需要额外权限。';
  } else if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    code = 'rate_limited';
    suggestion = '请求过于频繁或额度受限，稍后重试或切换模型。';
    retryable = true;
  } else if (lower.includes('404') || lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist'))) {
    code = 'model_not_found';
    suggestion = '检查模型名称是否拼写正确，以及该 Provider 是否开放该模型。';
  } else if (lower.includes('context') || lower.includes('maximum context') || lower.includes('token limit')) {
    code = 'context_limit';
    suggestion = '上下文过长。可以新建会话、减少输入内容，或等待上下文压缩后重试。';
  } else if (lower.includes('permission') || lower.includes('operation cancelled')) {
    code = 'permission_denied';
    suggestion = '操作被取消或权限不足。确认权限模式和工具确认弹窗。';
  } else if (lower.includes('fetch failed') || lower.includes('network') || lower.includes('econn') || lower.includes('timeout')) {
    code = 'network_error';
    suggestion = '网络请求失败。检查网络、代理、Base URL，稍后重试。';
    retryable = true;
  } else if (lower.startsWith('error:')) {
    code = 'tool_error';
    suggestion = '工具执行失败。检查工具参数、路径或命令输出。';
  }

  return {
    code,
    message: raw.length > 1000 ? `${raw.slice(0, 1000)}...` : raw,
    suggestion,
    retryable,
    providerId: cfg.activeProvider,
    model: cfg.activeModel,
    raw,
  };
}

function checkFromError(id: string, label: string, error: unknown): ProviderTestCheck {
  const classified = classifyAgentError(error);
  return { id, label, status: 'fail', message: classified.message };
}

async function testOpenAICompatibleProvider(input: ProviderTestConfig): Promise<ProviderTestResult> {
  const checks: ProviderTestCheck[] = [];
  const apiKey = input.apiKey?.trim() || '';
  const model = input.model?.trim() || '';
  const baseUrl = normalizeOpenAIBaseUrl(input.baseUrl || '');

  if (!apiKey) checks.push({ id: 'api_key', label: 'API Key', status: 'fail', message: 'API Key 为空。' });
  else checks.push({ id: 'api_key', label: 'API Key', status: 'pass', message: '已填写。' });
  if (!baseUrl) checks.push({ id: 'base_url', label: 'Base URL', status: 'fail', message: 'Base URL 为空。' });
  else checks.push({ id: 'base_url', label: 'Base URL', status: 'pass', message: baseUrl });
  if (!model) checks.push({ id: 'model', label: '模型', status: 'fail', message: '模型名为空。' });
  if (checks.some(c => c.status === 'fail')) {
    return { status: 'fail', summary: '配置不完整。', checks, suggestion: '补全 API Key、Base URL 和模型名后再诊断。' };
  }

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const endpoint = `${baseUrl}/chat/completions`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        stream: false,
        max_tokens: 16,
        temperature: 0,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
    checks.push({ id: 'chat', label: '最小对话', status: 'pass', message: '模型可完成非流式请求。' });
  } catch (err) {
    checks.push(checkFromError('chat', '最小对话', err));
    return { status: 'fail', summary: 'Provider 诊断失败。', checks, suggestion: classifyAgentError(err).suggestion };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        stream: true,
        max_tokens: 16,
        temperature: 0,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
    checks.push({ id: 'streaming', label: '流式输出', status: response.body ? 'pass' : 'warn', message: response.body ? '支持流式响应。' : '响应成功，但未返回可读流。' });
    await response.body?.cancel().catch(() => {});
  } catch (err) {
    checks.push({ id: 'streaming', label: '流式输出', status: 'warn', message: classifyAgentError(err).message });
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Call diagnostic_echo with text OK.' }],
        tools: [{
          type: 'function',
          function: {
            name: 'diagnostic_echo',
            description: 'Echo diagnostic text.',
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        }],
        tool_choice: 'auto',
        stream: false,
        max_tokens: 32,
        temperature: 0,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text().catch(() => '')}`);
    const json = await response.json() as any;
    const toolCalls = json?.choices?.[0]?.message?.tool_calls;
    checks.push({
      id: 'tools',
      label: '工具调用',
      status: Array.isArray(toolCalls) && toolCalls.length > 0 ? 'pass' : 'warn',
      message: Array.isArray(toolCalls) && toolCalls.length > 0 ? '支持 tool calling。' : '请求成功，但模型未主动调用诊断工具。',
    });
    const reasoning = json?.choices?.[0]?.message?.reasoning_content;
    checks.push({ id: 'reasoning', label: 'Reasoning', status: reasoning ? 'pass' : 'warn', message: reasoning ? '检测到 reasoning_content。' : '未检测到 reasoning_content。' });
  } catch (err) {
    checks.push({ id: 'tools', label: '工具调用', status: 'warn', message: classifyAgentError(err).message });
  }

  const visionPatterns = ['gpt-4', 'vision', 'vl', 'gemini', 'qwen'];
  const vision = visionPatterns.some(k => model.toLowerCase().includes(k));
  checks.push({ id: 'vision', label: 'Vision', status: vision ? 'warn' : 'warn', message: vision ? '按模型名推断可能支持图片，未发送图片实测。' : '按模型名未推断出图片能力。' });

  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  return {
    status: hasFail ? 'fail' : hasWarn ? 'warn' : 'pass',
    summary: hasFail ? '诊断失败。' : hasWarn ? '基础连接通过，但存在兼容性警告。' : '诊断通过。',
    checks,
    suggestion: hasWarn ? '如果工具调用或 reasoning 是必须能力，请用真实任务再验证一次。' : undefined,
  };
}

function ensurePath(workspaceRoot: string, inputPath: string): string {
  const p = inputPath.trim() || '.';
  const resolved = resolve(workspaceRoot, p);
  const normalizedRoot = resolve(workspaceRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + '\\') && !resolved.startsWith(normalizedRoot + '/')) {
    throw new Error(`Path escapes workspace root: ${p}`);
  }
  return resolved;
}

export function setupIpcHandlers(
  getProvider: (modelId?: string, options?: { stream?: boolean; maxTokens?: number }) => Provider,
  getTools: (sessionId?: string) => ToolRegistry,
) {
  onCollabEvent((event) => {
    getWindow()?.webContents.send('collab:event', event);
  });

  function getSessionModelId(sessionId?: string): string {
    const cfg = getConfig();
    if (!sessionId) return cfg.activeModel;
    if (sessionId === QUICK_CHAT_SESSION_ID || sessionId === '__quick_find__') {
      const quickModel = cfg.quickLauncher?.modelId;
      if (quickModel && cfg.providers.some(p => p.models.some(m => m.name === quickModel))) {
        sessionModels.set(sessionId, quickModel);
        return quickModel;
      }
    }
    const cached = sessionModels.get(sessionId);
    if (cached) return cached;
    const savedModel = loadSession(sessionId)?.modelId;
    if (savedModel) {
      sessionModels.set(sessionId, savedModel);
      return savedModel;
    }
    return cfg.activeModel;
  }

  function getContextConfig(sessionId?: string): { contextLimit: number; maxTokens: number } {
    const cfg = getConfig();
    const modelId = getSessionModelId(sessionId);
    const mc = getModelConfig(modelId);
    return {
      contextLimit: mc?.contextLimit || cfg.agent.contextLimit || 128_000,
      maxTokens: mc?.maxTokens || cfg.agent.maxTokens || 16_384,
    };
  }

  function createSessionAgent(sessionId: string, messages?: Message[]): AgentRuntime {
    const cfg = getConfig();
    const modelId = getSessionModelId(sessionId);
    const agent = new AgentRuntime(
      getProvider(modelId),
      getTools(sessionId),
      cfg.agent.maxTurns,
      buildFullPrompt(),
      getContextConfig(sessionId),
    );
    if (messages?.length) agent.loadMessages(messages);
    return agent;
  }

  function contextStatusToRunStatus(status: ContextStatus, sessionId?: string): Partial<RunStatusEvent> {
    // Persist compactCount when agent has real compaction data
    if (sessionId && (status.compactCount ?? 0) > 0) {
      sessionCompactMeta.set(sessionId, { compactCount: status.compactCount ?? 0, lastCompactAt: status.lastCompactAt ?? null });
    }
    // Override from cache if fresh agent reports 0 (session switch)
    let compactCount: number = (status.compactCount ?? 0);
    let lastCompactAt: number | null = (status.lastCompactAt ?? null);
    if (sessionId && compactCount === 0) {
      const cached = sessionCompactMeta.get(sessionId);
      if (cached) { compactCount = cached.compactCount; lastCompactAt = cached.lastCompactAt; }
    }
    return {
      currentTokens: status.currentTokens,
      estimatedTokens: status.estimatedTokens,
      contextLimit: status.contextLimit,
      effectiveWindow: status.effectiveWindow,
      reservedOutputTokens: status.reservedOutputTokens,
      autoCompactThreshold: status.autoCompactThreshold,
      autoCompactBufferTokens: status.autoCompactBufferTokens,
      blockingThreshold: status.blockingThreshold,
      freeTokens: status.freeTokens,
      percentUsed: status.percentUsed,
      willAutoCompact: status.willAutoCompact,
      contextSource: status.source,
      compacting: status.compacting,
      compacted: status.compacted,
      lastCompactAt,
      compactCount,
      compactError: status.compactError,
      consecutiveCompactFailures: status.consecutiveCompactFailures,
    };
  }

  function emptyContextStatus(sessionId?: string): ContextStatus {
    const { contextLimit, maxTokens } = getContextConfig(sessionId);
    const reservedOutputTokens = Math.min(maxTokens, MAX_RESERVED_OUTPUT_TOKENS);
    const effectiveWindow = Math.max(0, contextLimit - reservedOutputTokens);
    const autoCompactThreshold = getAutoCompactThreshold(effectiveWindow);
    const blockingThreshold = Math.max(0, effectiveWindow - BLOCKING_BUFFER_TOKENS);
    return {
      currentTokens: 0,
      estimatedTokens: 0,
      contextLimit,
      effectiveWindow,
      reservedOutputTokens,
      autoCompactThreshold,
      autoCompactBufferTokens: Math.max(0, effectiveWindow - autoCompactThreshold),
      blockingThreshold,
      freeTokens: effectiveWindow,
      percentUsed: 0,
      willAutoCompact: false,
      source: 'estimate',
      compacting: false,
      compacted: false,
      lastCompactAt: null,
      compactCount: 0,
      compactError: null,
      consecutiveCompactFailures: 0,
    };
  }

  function cancelPendingInteractionsForSession(sessionId: string, reason: string): void {
    for (const [askId, pending] of pendingAsks) {
      if (pending.sessionId === sessionId) {
        pendingAsks.delete(askId);
        pending.reject(new Error(reason));
      }
    }
    for (const [confirmId, pending] of pendingConfirms) {
      if (pending.sessionId === sessionId) {
        pendingConfirms.delete(confirmId);
        pending.resolve(false);
      }
    }
  }

  // ---- Agent ----

  async function runAgentTurnWithStreaming(
    sessionId: string,
    sessionAgent: AgentRuntime,
    message: string,
    attachments: { type: string; data: string; mimeType: string }[],
    abortCtrl: AbortController,
  ) {
    let deltaBuffer = '';
    let reasoningBuffer = '';
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let errorSent = false;
    let thinkingNotified = false;
    const flushDelta = () => {
      if (reasoningBuffer) {
        if (!thinkingNotified) { emitRunStatus(sessionId, { phase: 'thinking' }); thinkingNotified = true; }
        getWindow()?.webContents.send('agent:thinking-delta', sessionId, reasoningBuffer);
        reasoningBuffer = '';
      }
      if (deltaBuffer) {
        emitRunStatus(sessionId, { phase: 'streaming' });
        getWindow()?.webContents.send('agent:delta', sessionId, deltaBuffer);
        deltaBuffer = '';
      }
    };

    try {
      emitRunStatus(sessionId, { phase: 'starting', startedAt: Date.now(), inputTokens: 0, outputTokens: 0, currentTool: null, lastTool: null, errorCode: null });
      claimPetSession(sessionId);
      const result = await sessionAgent.runUserTurn(
        message,
        attachments as { type: 'image'; data: string; mimeType: string }[],
        {
          onModelRequest() {
            emitRunStatus(sessionId, { phase: 'requesting_model', currentTool: null });
          },
          onContextUpdate(status) {
            emitRunStatus(sessionId, {
              phase: 'requesting_model',
              ...contextStatusToRunStatus(status),
            });
          },
          onDelta(text) {
            if (!flushTimer) flushTimer = setInterval(flushDelta, 50);
            deltaBuffer += text;
          },
          onReasoning(text) {
            if (!flushTimer) flushTimer = setInterval(flushDelta, 50);
            reasoningBuffer += text;
          },
          onToolStart(toolCall) {
            emitRunStatus(sessionId, { phase: 'tool_running', currentTool: toolCall.name });
            getWindow()?.webContents.send('agent:tool-start', sessionId, toolCall);
          },
          onToolResult(toolCall, result) {
            emitRunStatus(sessionId, { phase: 'requesting_model', currentTool: null, lastTool: toolCall.name });
            getWindow()?.webContents.send('agent:tool-result', sessionId, {
              toolCallId: toolCall.id,
              name: toolCall.name,
              argumentsText: toolCall.argumentsText,
              result,
            });
          },
          onToolSummary(summary, tools) {
            if (!summary) return;
            getWindow()?.webContents.send('agent:tool-summary', sessionId, {
              summary,
              tools: tools.map(tool => ({
                name: tool.name,
                argumentsText: tool.argumentsText,
                resultPreview: tool.result.length > 500 ? `${tool.result.slice(0, 500)}...` : tool.result,
              })),
            });
          },
          takeQueuedUserMessage() {
            return takeQueuedTurn(sessionId);
          },
          onQueuedUserMessage(queued) {
            emitQueuedMessageStart(sessionId, queued);
          },
          onComplete(step) {
            flushDelta();
            emitRunStatus(sessionId, { phase: 'finishing', currentTool: null });
            releasePetSession(sessionId);
            // Cost tracking
            if (step.usage) {
              const costModel = getSessionModelId(sessionId);
              const turnCost = calculateUSDCost(costModel, step.usage);
              addToTotalSessionCost(turnCost, step.usage, costModel);
              getWindow()?.webContents.send('cost:updated', getCostSummary());
            }
            getWindow()?.webContents.send('agent:turn-done', sessionId, step);
            // Session memory: check if we should extract
            const msgs = sessionAgent.getMessages();
            const wsRoot = getConfig().agent.workspaceRoot;
            if (shouldExtractMemory(msgs, wsRoot)) {
              const prov = getProvider(getSessionModelId(sessionId));
              void extractSessionMemory(msgs, wsRoot, () => prov).catch(() => {});
            }
            requestWindowAttention();
          },
          onError(error) {
            const agentError = classifyAgentError(error);
            emitRunStatus(sessionId, { phase: agentError.code === 'aborted' ? 'aborted' : 'error', errorCode: agentError.code, currentTool: null });
            if (agentError.code !== 'aborted') {
              errorSent = true;
              getWindow()?.webContents.send('agent:error', sessionId, agentError);
            }
          },
        },
        abortCtrl.signal,
        sessionId,
      );
      if (flushTimer) { clearInterval(flushTimer); flushDelta(); }

      return result;
    } catch (err) {
      if (flushTimer) { clearInterval(flushTimer); flushDelta(); }
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = msg === 'Aborted'
        || (err instanceof Error && err.name === 'AbortError')
        || (typeof DOMException !== 'undefined' && err instanceof DOMException);
      if (isAbort) {
        emitRunStatus(sessionId, { phase: 'aborted', currentTool: null, errorCode: 'aborted' });
        releasePetSession(sessionId);
      } else {
        const agentError = classifyAgentError(err);
        emitRunStatus(sessionId, { phase: 'error', currentTool: null, errorCode: agentError.code });
        if (!errorSent) getWindow()?.webContents.send('agent:error', sessionId, agentError);
      }
      return null;
    }
  }

  async function runCollabTurnWithStreaming(
    sessionId: string,
    message: string,
    attachments: { type: string; data: string; mimeType: string }[],
    abortCtrl: AbortController,
  ) {
    try {
      emitRunStatus(sessionId, { phase: 'starting', startedAt: Date.now(), inputTokens: 0, outputTokens: 0, currentTool: 'model_collaboration', lastTool: null, errorCode: null });
      claimPetSession(sessionId);
      setPetState('thinking');
      sayPet('模型协同中...');
      const cfg = getConfig();
      const result = await runCollabTask({
        sessionId,
        userMessage: message,
        attachments: normalizeAttachments(attachments),
        workspaceRoot: cfg.agent.workspaceRoot,
        config: cfg.collab,
        signal: abortCtrl.signal,
      });
      emitRunStatus(sessionId, { phase: 'finishing', currentTool: null, lastTool: 'model_collaboration' });
      releasePetSession(sessionId);
      getWindow()?.webContents.send('agent:turn-done', sessionId, {
        text: result.finalText,
        toolCalls: [],
      });
      requestWindowAttention();
      return result;
    } catch (err) {
      const agentError = classifyAgentError(err);
      emitRunStatus(sessionId, { phase: agentError.code === 'aborted' ? 'aborted' : 'error', errorCode: agentError.code, currentTool: null });
      releasePetSession(sessionId);
      if (agentError.code !== 'aborted') getWindow()?.webContents.send('agent:error', sessionId, agentError);
      return null;
    }
  }

  function isCollabEnabled(): boolean {
    return getConfig().collab.enabled === true;
  }

  async function runUserMessageByMode(
    sessionId: string,
    message: string,
    attachments: { type: string; data: string; mimeType: string }[],
    abortCtrl: AbortController,
  ): Promise<unknown> {
    if (isCollabEnabled()) {
      return runCollabTurnWithStreaming(sessionId, message, attachments, abortCtrl);
    }
    const p = getProvider(getSessionModelId(sessionId));
    if (!p) throw new Error('No provider configured');
    const sessionAgent = getOrCreateSessionAgent(sessionId);
    return runAgentTurnWithStreaming(sessionId, sessionAgent, message, attachments, abortCtrl);
  }

  function getOrCreateSessionAgent(sessionId: string): AgentRuntime {
    const existing = sessionAgents.get(sessionId);
    if (existing) {
      const messages = existing.getMessages();
      const agent = createSessionAgent(sessionId, messages);
      sessionAgents.set(sessionId, agent);
      return agent;
    }
    const agent = createSessionAgent(sessionId);
    sessionAgents.set(sessionId, agent);
    return agent;
  }

  function abortPreviousRun(sessionId: string): AbortController {
    const prevAbort = sessionAbortControllers.get(sessionId);
    if (prevAbort) prevAbort.abort();
    const abortCtrl = new AbortController();
    sessionAbortControllers.set(sessionId, abortCtrl);
    return abortCtrl;
  }

  function abortCurrentRun(sessionId: string): void {
    sessionAbortControllers.get(sessionId)?.abort();
  }

  function newRunController(sessionId: string): AbortController {
    const ctrl = new AbortController();
    sessionAbortControllers.set(sessionId, ctrl);
    return ctrl;
  }

  function startQueuedTurnIfIdle(sessionId: string): void {
    if (sessionRunningTurns.has(sessionId)) return;
    const queued = takeQueuedTurn(sessionId);
    if (!queued) return;
    emitQueuedMessageStart(sessionId, queued);
    void runAgentTurnSerial(sessionId, async (abortCtrl) => {
      return runUserMessageByMode(sessionId, queued.content, queued.attachments, abortCtrl);
    });
  }

  async function runAgentTurnSerial(sessionId: string, runFn: (abortCtrl: AbortController) => Promise<unknown>): Promise<unknown> {
    const prev = sessionRunningTurns.get(sessionId);
    if (prev) await prev.catch(() => {});
    const abortCtrl = newRunController(sessionId);
    const promise = runFn(abortCtrl);
    sessionRunningTurns.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      if (sessionRunningTurns.get(sessionId) === promise) {
        sessionRunningTurns.delete(sessionId);
        startQueuedTurnIfIdle(sessionId);
      }
    }
  }

  function getQuickWindow() {
    return getQuickLauncherWindow();
  }

  function emitQuick(channel: string, ...args: unknown[]): void {
    getQuickWindow()?.webContents.send(channel, ...args);
  }

  function notifySessionsChanged(sessionId?: string): void {
    const payload = JSON.stringify({ sessionId });
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('session:saved', { sessionId });
      win.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('session-saved', { detail: ${payload} }))`,
      ).catch(() => {});
    }
  }

  function quickEntry(role: 'user' | 'assistant' | 'tool', content: string, extra: Record<string, unknown> = {}) {
    const entry = {
      id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      role,
      content,
      timestamp: Date.now(),
      ...extra,
    };
    quickChatEntries.push(entry);
    return entry;
  }

  async function runQuickChatTurn(message: string, attachments: Attachment[], abortCtrl: AbortController): Promise<unknown> {
    const agent = getOrCreateSessionAgent(QUICK_CHAT_SESSION_ID);
    let deltaBuffer = '';
    let reasoningBuffer = '';
    let finalText = '';
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    let errorSent = false;
    let thinkingNotified = false;

    const flushDelta = () => {
      if (reasoningBuffer) {
        if (!thinkingNotified) {
          emitQuick('quick-chat:run-status', { phase: 'thinking', lastEventAt: Date.now() });
          thinkingNotified = true;
        }
        emitQuick('quick-chat:thinking-delta', reasoningBuffer);
        reasoningBuffer = '';
      }
      if (deltaBuffer) {
        finalText += deltaBuffer;
        emitQuick('quick-chat:run-status', { phase: 'streaming', lastEventAt: Date.now() });
        emitQuick('quick-chat:delta', deltaBuffer);
        deltaBuffer = '';
      }
    };

    try {
      emitQuick('quick-chat:run-status', { phase: 'starting', startedAt: Date.now(), lastEventAt: Date.now(), currentTool: null, errorCode: null });
      setPetState('thinking'); sayPet('\u{1F4AC} Quick Chat...');
      claimPetSession(QUICK_CHAT_SESSION_ID);
      const result = await agent.runUserTurn(
        message,
        attachments,
        {
          onModelRequest() {
            emitQuick('quick-chat:run-status', { phase: 'requesting_model', lastEventAt: Date.now(), currentTool: null });
          },
          onContextUpdate(status) {
            emitQuick('quick-chat:run-status', {
              phase: 'requesting_model',
              lastEventAt: Date.now(),
              ...contextStatusToRunStatus(status),
            });
          },
          onDelta(text) {
            if (!flushTimer) flushTimer = setInterval(flushDelta, 50);
            deltaBuffer += text;
          },
          onReasoning(text) {
            if (!flushTimer) flushTimer = setInterval(flushDelta, 50);
            reasoningBuffer += text;
          },
          onToolStart(toolCall) {
            emitQuick('quick-chat:run-status', { phase: 'tool_running', lastEventAt: Date.now(), currentTool: toolCall.name });
            setPetState('working'); sayPet('\u{1F527} ' + (toolCall.name || 'Working'));
            const entry = quickEntry('tool', '', {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              toolArgs: toolCall.argumentsText,
            });
            emitQuick('quick-chat:tool-start', entry);
          },
          onToolResult(toolCall, toolResult) {
            emitQuick('quick-chat:run-status', { phase: 'requesting_model', lastEventAt: Date.now(), currentTool: null, lastTool: toolCall.name });
            for (let i = quickChatEntries.length - 1; i >= 0; i--) {
              if (quickChatEntries[i].toolCallId === toolCall.id) {
                quickChatEntries[i] = { ...quickChatEntries[i], content: toolResult, toolResult };
                break;
              }
            }
            emitQuick('quick-chat:tool-result', {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: toolResult,
            });
          },
          onComplete(step) {
            flushDelta();
            const assistantText = step.text || finalText;
            quickEntry('assistant', assistantText);
            emitQuick('quick-chat:run-status', { phase: 'finishing', lastEventAt: Date.now(), currentTool: null });
            setPetState('attention'); sayPet('\u{2705} Done');
            releasePetSession(QUICK_CHAT_SESSION_ID);
            emitQuick('quick-chat:done', { text: assistantText });
          },
          onError(error) {
            const agentError = classifyAgentError(error);
            emitQuick('quick-chat:run-status', {
              phase: agentError.code === 'aborted' ? 'aborted' : 'error',
              lastEventAt: Date.now(),
              errorCode: agentError.code,
              currentTool: null,
            });
            if (agentError.code !== 'aborted') {
              errorSent = true;
              emitQuick('quick-chat:error', agentError);
            }
          },
        },
        abortCtrl.signal,
      );
      if (flushTimer) { clearInterval(flushTimer); flushDelta(); }
      return result;
    } catch (err) {
      if (flushTimer) { clearInterval(flushTimer); flushDelta(); }
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = msg === 'Aborted' || (err instanceof Error && err.name === 'AbortError');
      if (isAbort) {
        emitQuick('quick-chat:run-status', { phase: 'aborted', lastEventAt: Date.now(), currentTool: null, errorCode: 'aborted' });
        setPetState('idle');
        releasePetSession(QUICK_CHAT_SESSION_ID);
      } else {
        const agentError = classifyAgentError(err);
        emitQuick('quick-chat:run-status', { phase: 'error', lastEventAt: Date.now(), currentTool: null, errorCode: agentError.code });
        setPetState('error'); sayPet('\u{274C} Error');
        releasePetSession(QUICK_CHAT_SESSION_ID);
        if (!errorSent) emitQuick('quick-chat:error', agentError);
      }
      return null;
    }
  }

  ipcMain.handle('quick-chat:send', async (_event, message: string) => {
    const text = String(message || '').trim();
    if (!text) return { ok: false, error: 'EMPTY_MESSAGE' };
    if (sessionRunningTurns.has(QUICK_CHAT_SESSION_ID)) {
      return { ok: false, error: 'BUSY' };
    }
    const entry = quickEntry('user', text);
    emitQuick('quick-chat:user', entry);
    return runAgentTurnSerial(QUICK_CHAT_SESSION_ID, async (abortCtrl) => runQuickChatTurn(text, [], abortCtrl));
  });

  ipcMain.handle('quick-chat:abort', () => {
    sessionAbortControllers.get(QUICK_CHAT_SESSION_ID)?.abort();
    sessionAbortControllers.delete(QUICK_CHAT_SESSION_ID);
    clearQueuedTurns(QUICK_CHAT_SESSION_ID);
    cancelPendingInteractionsForSession(QUICK_CHAT_SESSION_ID, 'Quick chat aborted');
        emitQuick('quick-chat:run-status', { phase: 'aborted', lastEventAt: Date.now(), currentTool: null, errorCode: 'aborted' });
        setPetState('idle');
  });

  ipcMain.handle('quick-chat:clear', () => {
    sessionAbortControllers.get(QUICK_CHAT_SESSION_ID)?.abort();
    sessionAbortControllers.delete(QUICK_CHAT_SESSION_ID);
    sessionAgents.delete(QUICK_CHAT_SESSION_ID);
    sessionModels.delete(QUICK_CHAT_SESSION_ID);
    clearQueuedTurns(QUICK_CHAT_SESSION_ID);
    cancelPendingInteractionsForSession(QUICK_CHAT_SESSION_ID, 'Quick chat cleared');
    quickChatEntries.splice(0, quickChatEntries.length);
    quickChatSavedSessionId = null;
    emitQuick('quick-chat:cleared');
    releasePetSession(QUICK_CHAT_SESSION_ID);
  });

  ipcMain.handle('quick-chat:save-session', async (event) => {
    try {
      if (quickChatEntries.length === 0) return { ok: false, error: 'EMPTY_CHAT' };
      const id = quickChatSavedSessionId || `session_quick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      const firstUser = quickChatEntries.find(e => e.role === 'user')?.content;
      const agent = sessionAgents.get(QUICK_CHAT_SESSION_ID);
      saveSession({
        id,
        title: typeof firstUser === 'string' ? firstUser.slice(0, 50) : 'Quick Chat',
        projectPath: '',
        modelId: getSessionModelId(QUICK_CHAT_SESSION_ID),
        messages: quickChatEntries.map(entry => ({ ...entry })),
        agentMessages: agent?.getMessages() || [],
        createdAt: now,
        updatedAt: now,
      });
      quickChatSavedSessionId = id;
      const payload = { sessionId: id };
      event.sender.send('quick-chat:saved', payload);
      if (getQuickWindow()?.webContents.id !== event.sender.id) {
        emitQuick('quick-chat:saved', payload);
      }
      notifySessionsChanged(id);
      return { ok: true, sessionId: id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      event.sender.send('quick-chat:save-error', { message });
      return { ok: false, error: message || 'SAVE_FAILED' };
    }
  });

  // ── QuickFind Agent 语义检索（轻量专用，每次独立上下文）──
  const FIND_SESSION = '__quick_find__';
  let findAbortController: AbortController | null = null;


function claimPetSession(sessionId: string) {
  if (sessionId !== QUICK_CHAT_SESSION_ID && sessionId !== FIND_SESSION) {
    activePetSession = sessionId;
  } else if (!activePetSession || activePetSession === QUICK_CHAT_SESSION_ID || activePetSession === FIND_SESSION) {
    activePetSession = sessionId;
  }
}

function releasePetSession(sessionId: string) {
  if (activePetSession === sessionId) {
    activePetSession = null;
    setPetState('idle');
  }
}
  const FIND_SYSTEM_PROMPT = `你是文件检索专家。用户用自然语言描述想找的文件或目录，你只能使用以下工具在磁盘上实际查找，绝不编造路径。

工具：
- everything_search: 全盘毫秒搜索所有 NTFS 卷，传多个关键词用空格分隔
- list_dir: 列出目录内容
- read_file: 读取文件内容（用于确认文件是否匹配）
- grep: 在文件中搜索文本

流程：
1. 提取用户描述中的核心关键词（中英文都试），用 everything_search 全盘搜索
2. 结果不够精确时用 list_dir 浏览候选目录
3. 最终整理成 JSON 返回

回复末尾必须附 JSON 块（最多 10 条）：
\`\`\`json
[{ "name": "名称", "path": "完整绝对路径", "isDir": true/false }]
\`\`\``;

  // 清除 Find 会话
  ipcMain.handle('quick-find:clear', () => {
    findAbortController?.abort();
    findAbortController = null;
    sessionAgents.delete(FIND_SESSION);
    cancelPendingInteractionsForSession(FIND_SESSION, 'Find cleared');
    releasePetSession(FIND_SESSION);
  });

  ipcMain.handle('quick-find:agent-search', async (_event, query: string) => {
    const text = String(query || '').trim();
    if (!text) return [];
    try {
      if (!getProvider()) return [];

      findAbortController?.abort();
      findAbortController = new AbortController();

      // 精简 ToolRegistry：4 个只读工具 + everything_search
      const baseTools = getTools(FIND_SESSION);
      const allowedTools = new Set(['list_dir', 'read_file', 'grep']);
      const wrappedTools: ToolRegistry = {
        getDefinitions() {
          return [
            ...baseTools.getDefinitions().filter(d => allowedTools.has(d.function.name)),
            {
              type: 'function' as const,
              function: {
                name: 'everything_search',
                description: 'Instant full-disk search across ALL NTFS drives. Returns real paths. Use space-separated keywords in Chinese and/or English.',
                parameters: {
                  type: 'object',
                  properties: { query: { type: 'string', description: 'Keywords separated by spaces.' } },
                  required: ['query'],
                },
              },
              readOnly: true,
            },
          ];
        },
        setRunContext(ctx: any) { baseTools.setRunContext?.(ctx); },
        async execute(tc: ToolCall) {
          if (tc.name === 'everything_search') {
            const args = (() => { try { return JSON.parse(tc.argumentsText || '{}'); } catch { return {}; } })();
            const { everythingSearch } = require('./quick-launcher/everything');
            const results = await everythingSearch(String(args.query || ''), 30);
            return JSON.stringify(results.map((r: { name: string; fullPath: string; isFolder: boolean }) => ({
              name: r.name, path: r.fullPath, type: r.isFolder ? 'directory' : 'file',
            })));
          }
          return baseTools.execute(tc);
        },
      };

      // 每次独立 Agent（干净上下文，不累积历史）
      const cfg = getConfig();
      const agent = new AgentRuntime(
        getProvider(getSessionModelId(FIND_SESSION)),
        wrappedTools,
        cfg.agent.maxTurns,
        FIND_SYSTEM_PROMPT,
        getContextConfig(FIND_SESSION),
      );
      sessionAgents.set(FIND_SESSION, agent);

      const result = await agent.runUserTurn(
        text, [],
        {
          onModelRequest() {},
          onContextUpdate() {},
          onDelta() { getQuickWindow()?.webContents.send('quick-find:delta', arguments[0]); },
          onReasoning() {},
          onToolStart(tc: ToolCall) { getQuickWindow()?.webContents.send('quick-find:tool', { name: tc.name, args: tc.argumentsText }); setPetState('thinking'); sayPet('\u{1F50D} Searching...'); },
          onToolResult() {},
          onComplete() { setPetState('attention'); sayPet('\u{2705} Found'); },
          onError() { setPetState('error'); },
        },
        findAbortController.signal,
      );

      // 先检查收藏列表是否有匹配（0 延迟）
      const favorites = getConfig().quickLauncher?.favorites || [];
      const favResults: Array<{ id: string; path: string; name: string; isDir: boolean; score: number; source: string }> = [];
      if (favorites.length > 0) {
        const lowerText = text.toLowerCase();
        for (const fav of favorites) {
          const favLower = fav.toLowerCase();
          const name = fav.split('\\').pop() || fav;
          if (favLower.includes(lowerText) || name.toLowerCase().includes(lowerText)) {
            try { require('fs').accessSync(fav); } catch { continue; }
            const stat = require('fs').statSync(fav);
            favResults.push({
              id: fav, path: fav, name,
              isDir: stat.isDirectory(),
              score: 999, source: 'favorite',
            });
          }
        }
      }

      const responseText = result?.text || '';
      const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1]);
          if (Array.isArray(parsed)) {
            return parsed.slice(0, 10).map((item: Record<string, unknown>, i: number) => ({
              id: `agent_${i}`, path: String(item.path || ''), name: String(item.name || ''),
              isDir: Boolean(item.isDir), score: 90 - i * 5, source: 'agent',
            }));
          }
        } catch {}
      }
      const pathMatches = responseText.match(/[A-Z]:\\[^\s,}\]"'\n]+/g) || [];
      return pathMatches.slice(0, 10).map((p: string, i: number) => ({
        id: `agent_path_${i}`, path: p, name: p.split('\\').pop() || p,
        isDir: !p.includes('.'), score: 70 - i * 5, source: 'agent',
      }));
    } catch (err: any) {
      if (err?.message === 'Aborted') { releasePetSession(FIND_SESSION); return []; }
      return [];
    }
  });

  ipcMain.handle('agent:send-message', async (_event, sessionId: string, message: string, attachments: { type: string; data: string; mimeType: string }[]) => {
    const normalizedAttachments = normalizeAttachments(attachments || []);
    if (sessionRunningTurns.has(sessionId)) {
      const queued = enqueueQueuedTurn(sessionId, message, normalizedAttachments);
      return { queued: true, queuedId: queued.id, queuedCount: sessionQueuedTurns.get(sessionId)?.length || 0 };
    }
    return runAgentTurnSerial(sessionId, async (abortCtrl) => {
      return runUserMessageByMode(sessionId, message, normalizedAttachments, abortCtrl);
    });
  });

  ipcMain.handle('agent:regenerate', async (_event, sessionId: string, message: string, attachments: { type: string; data: string; mimeType: string }[]) => {
    return runAgentTurnSerial(sessionId, async (abortCtrl) => {
      if (isCollabEnabled()) {
        return runCollabTurnWithStreaming(sessionId, message, normalizeAttachments(attachments || []), abortCtrl);
      }
      const p = getProvider(getSessionModelId(sessionId));
      if (!p) throw new Error('No provider configured');
      const sessionAgent = getOrCreateSessionAgent(sessionId);
      sessionAgent.removeLastUserTurn();
      return runAgentTurnWithStreaming(sessionId, sessionAgent, message, normalizeAttachments(attachments || []), abortCtrl);
    });
  });

  ipcMain.handle('agent:abort', (_event, sessionId: string) => {
    sessionAbortControllers.get(sessionId)?.abort();
    sessionAbortControllers.delete(sessionId);
    clearQueuedTurns(sessionId);
    cancelPendingInteractionsForSession(sessionId, 'Session aborted');
    emitRunStatus(sessionId, { phase: 'aborted', currentTool: null, errorCode: 'aborted' });
  });

  ipcMain.handle('session:set-model', (_event, sessionId: string, modelId: string) => {
    sessionModels.set(sessionId, modelId);
    const saved = loadSession(sessionId);
    if (saved) saveSession({ ...saved, modelId });
    const existing = sessionAgents.get(sessionId);
    if (existing) {
      const agent = createSessionAgent(sessionId, existing.getMessages());
      sessionAgents.set(sessionId, agent);
      emitRunStatus(sessionId, { phase: 'idle', ...contextStatusToRunStatus(agent.getContextStatus(), sessionId) });
    }
  });

  ipcMain.handle('agent:reset', (_event, sessionId: string) => {
    sessionAgents.delete(sessionId);
    sessionAbortControllers.delete(sessionId);
    sessionModels.delete(sessionId);
    sessionCompactMeta.delete(sessionId);
    clearQueuedTurns(sessionId);
    cancelPendingInteractionsForSession(sessionId, 'Session reset');
  });

  ipcMain.handle('agent:set-context', async (_event, sessionId: string, messages: Array<{ role: string; content: string }>, modelId?: string) => {
    if (modelId) sessionModels.set(sessionId, modelId);
    const p = getProvider(getSessionModelId(sessionId));
    if (!p) throw new Error('No provider configured');
    const agent = createSessionAgent(sessionId);
    agent.loadMessages(messages as any);
    sessionAgents.set(sessionId, agent);
    const context = agent.getContextStatus();
    emitRunStatus(sessionId, { phase: 'idle', ...contextStatusToRunStatus(context, sessionId), compacted: false });
    return context;
  });

  function getContextStatusForSession(sessionId: string): ContextStatus {
    try {
      return getOrCreateSessionAgent(sessionId).getContextStatus();
    } catch {
      return emptyContextStatus(sessionId);
    }
  }

  ipcMain.handle('agent:get-context-status', (_event, sessionId: string) => getContextStatusForSession(sessionId));
  ipcMain.handle('agent:refresh-context-status', (_event, sessionId: string) => {
    const status = getContextStatusForSession(sessionId);
    emitRunStatus(sessionId, { phase: 'idle', ...contextStatusToRunStatus(status, sessionId) });
    return status;
  });
  ipcMain.handle('agent:context-status', (_event, sessionId: string) => getContextStatusForSession(sessionId));

  // Ask-user-question round-trip
  ipcMain.handle('ask:respond', (_event, askId: string, answers: Record<string, string> | null) => {
    const pending = pendingAsks.get(askId);
    if (pending) {
      pendingAsks.delete(askId);
      if (answers) {
        pending.resolve(answers);
      } else {
        pending.reject(new Error('User cancelled'));
      }
    }
  });

  ipcMain.handle('confirm:respond', (_event, confirmId: string, approved: boolean) => {
    const pending = pendingConfirms.get(confirmId);
    if (pending) {
      pendingConfirms.delete(confirmId);
      pending.resolve(Boolean(approved));
    }
  });

  // ---- File system (direct) ----
  ipcMain.handle('fs:list-dir', async (_event, dirPath: string) => {
    const p = ensurePath(getConfig().agent.workspaceRoot, dirPath);
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => ({
        name: e.name,
        path: join(dirPath || '.', e.name).replace(/\\/g, '/'),
        isDir: e.isDirectory(),
      }));
  });

  ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
    const p = ensurePath(getConfig().agent.workspaceRoot, filePath);
    return await fs.readFile(p, 'utf8');
  });

  ipcMain.handle('fs:write-file', async (_event, filePath: string, content: string) => {
    const p = ensurePath(getConfig().agent.workspaceRoot, filePath);
    await fs.mkdir(dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  });

  // ---- Config ----
  ipcMain.handle('config:get', () => {
    const cfg = getConfig();
    const active = getActiveProvider();
    const modelContexts: Record<string, number> = {};
    for (const p of cfg.providers) {
      for (const m of p.models) {
        if (m.contextLimit) modelContexts[m.name] = m.contextLimit;
      }
    }
    return {
      version: require('../../package.json').version,
      model: cfg.activeModel,
      models: getAllModelNames(),
      modelContexts,
      providers: cfg.providers.map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, models: p.models })),
      activeProvider: cfg.activeProvider,
      workspaceRoot: cfg.agent.workspaceRoot,
      maxTurns: cfg.agent.maxTurns,
      maxTokens: cfg.agent.maxTokens,
      contextLimit: cfg.agent.contextLimit,
      permissionMode: cfg.permissionMode,
      theme: cfg.theme || 'light',
      lightScheme: cfg.lightScheme || 'default',
      fontScale: cfg.fontScale || 100,
      codeLeftWidth: cfg.codeLeftWidth,
      autoLaunch: cfg.autoLaunch || false,
      quickLauncher: cfg.quickLauncher,
      collab: cfg.collab,
      lastSeenReleaseNotesVersion: cfg.lastSeenReleaseNotesVersion,
      imAgent: cfg.imAgent,
      baseUrl: active.baseUrl,
      deepseekApiKey: cfg.providers.find(p => p.id === 'deepseek')?.apiKey || '',
      anthropicApiKey: cfg.providers.find(p => p.id === 'anthropic')?.apiKey || '',
    };
  });

  ipcMain.handle('config:set', async (_event, key: string, value: unknown) => {
    const cfg = getConfig();
    if (key === 'model') {
      cfg.activeModel = value as string;
      // Auto-set activeProvider based on which provider has this model
      for (const p of cfg.providers) {
        if (p.models.some(m => m.name === cfg.activeModel)) {
          cfg.activeProvider = p.id;
          break;
        }
      }
    }
    else if (key === 'activeProvider') cfg.activeProvider = value as string;
    else if (key === 'maxTurns') cfg.agent.maxTurns = value as number;
    else if (key === 'maxTokens') cfg.agent.maxTokens = value as number;
    else if (key === 'contextLimit') cfg.agent.contextLimit = value as number;
    else if (key === 'systemPrompt') cfg.systemPrompt = value as string;
    else if (key === 'workspaceRoot') { cfg.agent.workspaceRoot = value as string; await saveConfig(); return; }
    else if (key === 'theme') {
      cfg.theme = value as 'light' | 'dark';
      await saveConfig();
      syncQuickLauncherTheme();
      return;
    }
    else if (key === 'lightScheme') {
      cfg.lightScheme = value as string;
      await saveConfig();
      syncQuickLauncherTheme();
      return;
    }
    else if (key === 'codeLeftWidth') { cfg.codeLeftWidth = value as number; await saveConfig(); return; }
    else if (key === 'fontScale') { cfg.fontScale = value as number; await saveConfig(); return; }
    else if (key === 'lastSeenReleaseNotesVersion') { cfg.lastSeenReleaseNotesVersion = value as string; await saveConfig(); return; }
    else if (key === 'imAgent') {
      const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
      cfg.imAgent = {
        enabled: input.enabled === true,
        autoReplyWhenAway: input.autoReplyWhenAway === true,
        allowSessionList: input.allowSessionList !== false,
        allowSessionPreview: input.allowSessionPreview === true,
      };
      await saveConfig();
      return;
    }
    else if (key === 'collab') {
      const next = normalizeCollabConfig(value);
      if (next.enabled) {
        const check = await checkCollabCli(next);
        if (!check.ok) {
          next.enabled = false;
          cfg.collab = next;
          await saveConfig();
          throw new Error('模型协同需要 Codex CLI 和 Claude Code CLI 都可调用。');
        }
      }
      cfg.collab = next;
      await saveConfig();
      getWindow()?.webContents.send('collab:config-updated', cfg.collab);
      return;
    }
    else if (key === 'quickLauncher') {
      const input = (value && typeof value === 'object') ? value as Record<string, unknown> : {};
      cfg.quickLauncher = {
        ...(cfg.quickLauncher || {
          enabled: true,
          triggerWindowMs: 400,
          inputAutoHideMs: 5000,
          panelAutoHideMs: 10000,
          mode: 'chat' as const,
          findMaxDepth: 4,
        }),
        enabled: typeof input.enabled === 'boolean' ? input.enabled : cfg.quickLauncher?.enabled ?? true,
        triggerWindowMs: typeof input.triggerWindowMs === 'number' ? Math.max(150, Math.min(1200, input.triggerWindowMs)) : cfg.quickLauncher?.triggerWindowMs ?? 400,
        inputAutoHideMs: typeof input.inputAutoHideMs === 'number' ? Math.max(1000, Math.min(60000, input.inputAutoHideMs)) : cfg.quickLauncher?.inputAutoHideMs ?? 5000,
        panelAutoHideMs: typeof input.panelAutoHideMs === 'number' ? Math.max(1000, Math.min(120000, input.panelAutoHideMs)) : cfg.quickLauncher?.panelAutoHideMs ?? 10000,
        modelId: typeof input.modelId === 'string' && cfg.providers.some(p => p.models.some(m => m.name === input.modelId))
          ? input.modelId
          : cfg.quickLauncher?.modelId || 'deepseek-v4-flash',
        findMaxDepth: typeof input.findMaxDepth === 'number' ? Math.max(1, Math.min(8, input.findMaxDepth)) : cfg.quickLauncher?.findMaxDepth ?? 4,
      };
      sessionModels.delete(QUICK_CHAT_SESSION_ID);
      sessionModels.delete('__quick_find__');
      await saveConfig();
      return;
    }
    else if (key === 'deepseekApiKey') {
      const ds = cfg.providers.find(p => p.id === 'deepseek');
      if (ds) ds.apiKey = value as string;
    }
    else if (key === 'anthropicApiKey') {
      const ant = cfg.providers.find(p => p.id === 'anthropic');
      if (ant) ant.apiKey = value as string;
    }
    else if (key === 'baseUrl') {
      const active = getActiveProvider();
      active.baseUrl = value as string;
    }
    await saveConfig();
  });

  ipcMain.handle('config:get-full', () => getConfig());

  ipcMain.handle('collab:get-config', () => getConfig().collab);

  ipcMain.handle('collab:set-config', async (_event, value: unknown) => {
    const cfg = getConfig();
    const next = normalizeCollabConfig(value);
    if (next.enabled) {
      const check = await checkCollabCli(next);
      if (!check.ok) {
        next.enabled = false;
        cfg.collab = next;
        await saveConfig();
        getWindow()?.webContents.send('collab:config-updated', cfg.collab);
        throw new Error('模型协同需要 Codex CLI 和 Claude Code CLI 都可调用。');
      }
    }
    cfg.collab = next;
    await saveConfig();
    getWindow()?.webContents.send('collab:config-updated', cfg.collab);
    return cfg.collab;
  });

  ipcMain.handle('collab:check-cli', async (_event, value?: unknown) => {
    const cfg = getConfig();
    const target = value ? normalizeCollabConfig({ ...cfg.collab, ...(value as Record<string, unknown>) }) : cfg.collab;
    const result = await checkCollabCli(target);
    if (!result.ok && cfg.collab.enabled) {
      cfg.collab = { ...cfg.collab, enabled: false };
      await saveConfig();
      getWindow()?.webContents.send('collab:config-updated', cfg.collab);
    }
    return result;
  });

  ipcMain.handle('collab:get-session-status', (_event, sessionId: string) => {
    const cfg = getConfig();
    return getCollabSessionStatus(cfg.collab.enabled, sessionId, cfg.agent.workspaceRoot);
  });

  ipcMain.handle('collab:list-tasks', (_event, sessionId: string) => listCollabTaskViews(sessionId));

  ipcMain.handle('collab:abort-task', (_event, taskId: string) => abortCollabTask(taskId));

  ipcMain.handle('collab:retry-task', async (_event, taskId: string, phase?: string) => retryCollabTask(taskId, phase));

  ipcMain.handle('collab:approve-task', (_event, taskId: string) => approveCollabTask(taskId));

  ipcMain.handle('config:get-providers', () => {
    return getConfig().providers.map(p => ({ id: p.id, name: p.name, models: p.models.map(m => m.name) }));
  });

  ipcMain.handle('config:set-provider', async (_event, pc: ProviderConfig) => {
    const cfg = getConfig();
    if (!pc?.id?.trim()) throw new Error('Provider id is required');
    const idx = cfg.providers.findIndex(p => p.id === pc.id);
    if (idx >= 0) {
      const existing = cfg.providers[idx];
      cfg.providers[idx] = {
        ...existing,
        name: pc.name || existing.name,
        baseUrl: pc.baseUrl || existing.baseUrl,
        apiKey: pc.apiKey !== undefined ? pc.apiKey : existing.apiKey,
        models: Array.isArray(pc.models) ? pc.models : existing.models,
      };
    } else {
      if (!pc.name?.trim()) throw new Error('Provider name is required');
      if (!pc.baseUrl?.trim()) throw new Error('Provider baseUrl is required');
      cfg.providers.push({
        id: pc.id.trim(),
        name: pc.name.trim(),
        baseUrl: pc.baseUrl.trim(),
        apiKey: pc.apiKey || '',
        models: Array.isArray(pc.models) ? pc.models : [],
      });
    }
    await saveConfig();
  });

  ipcMain.handle('provider:test', async (_event, input: ProviderTestConfig) => {
    const providerName = `${input.providerId || ''} ${input.name || ''}`.toLowerCase();
    if (providerName.includes('anthropic')) {
      return {
        status: 'warn',
        summary: 'Anthropic 诊断第一版仅检查配置完整性。',
        checks: [
          { id: 'api_key', label: 'API Key', status: input.apiKey?.trim() ? 'pass' : 'fail', message: input.apiKey?.trim() ? '已填写。' : 'API Key 为空。' },
          { id: 'model', label: '模型', status: input.model?.trim() ? 'pass' : 'fail', message: input.model?.trim() ? input.model : '模型名为空。' },
          { id: 'compat', label: '兼容性', status: 'warn', message: '当前版本的深度诊断优先覆盖 OpenAI-compatible Provider。Anthropic 可通过真实会话验证。' },
        ],
        suggestion: '如果需要 Anthropic 深度诊断，后续可单独接入 Messages API 探测。',
      } satisfies ProviderTestResult;
    }
    const result = await testOpenAICompatibleProvider(input);

    // ── Try balance probe ──
    if (input.apiKey?.trim()) {
      const apiKey = input.apiKey.trim();
      const rawBase = (input.baseUrl || '').trim();
      const normalized = normalizeOpenAIBaseUrl(rawBase);
      const hostOnly = normalized.replace(/\/v\d+$/, '');
      const bases = [...new Set([rawBase, normalized, hostOnly].filter(Boolean))];
      const paths = ['/user/info', '/user/balance', '/v1/user/info'];

      for (const base of bases) {
        for (const path of paths) {
          const url = `${base}${path}`;
          if (url.includes('//user')) continue;
          try {
            const resp = await fetch(url, {
              headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
            });
            if (!resp.ok) continue;
            const data = await resp.json() as Record<string, any>;
            // DeepSeek format
            if (data?.balance_infos?.[0]) {
              const b = data.balance_infos[0];
              result.balance = {
                total: b.total_balance || '0',
                toppedUp: b.topped_up_balance,
                granted: b.granted_balance,
                currency: b.currency || 'CNY',
              };
              result.checks.push({ id: 'balance', label: '余额', status: 'pass', message: `总余额 ${b.total_balance} ${b.currency}` });
              return result;
            }
            // SiliconFlow / generic format
            if (data?.data?.totalBalance) {
              result.balance = {
                total: data.data.totalBalance,
                toppedUp: data.data.chargeBalance,
                granted: data.data.balance,
                currency: 'CNY',
              };
              result.checks.push({ id: 'balance', label: '余额', status: 'pass', message: `总余额 ${data.data.totalBalance} CNY` });
              return result;
            }
          } catch { /* skip */ }
        }
      }
    }

    return result;
  });

  // ---- Balance ----
  ipcMain.handle('balance:query', async (_event, providerId: string) => {
    const provider = getConfig().providers.find(p => p.id === providerId);
    if (!provider?.apiKey) return { error: 'API Key 未配置' };
    const apiKey = provider.apiKey;
    try {
      let url: string;
      if (providerId === 'deepseek') {
        url = 'https://api.deepseek.com/user/balance';
      } else if (providerId === 'siliconflow' || (provider.name && /硅基|silicon/i.test(provider.name))) {
        url = 'https://api.siliconflow.cn/v1/user/info';
      } else {
        return { error: '不支持的供应商' };
      }
      const response = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) return { error: `HTTP ${response.status}` };
      const raw = await response.json() as Record<string, any>;
      if (providerId === 'deepseek') {
        return raw;
      }
      if (raw?.data) {
        return {
          balance_infos: [{
            currency: 'CNY',
            total_balance: raw.data.totalBalance || raw.data.balance || '0',
            granted_balance: raw.data.balance || '0',
            topped_up_balance: raw.data.chargeBalance || '0',
          }],
        };
      }
      return raw;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Permission mode
  ipcMain.handle('permission:get', () => getPermissionMode());
  ipcMain.handle('permission:set', async (_event, mode: string) => {
    const valid: string[] = ['default', 'fullAccess', 'plan'];
    if (valid.includes(mode)) {
      currentPermissionMode = mode as PermissionMode;
      if (currentPermissionMode === 'plan') {
        enterPlanMode();
      } else {
        exitPlanMode();
      }
      const cfg = getConfig();
      cfg.permissionMode = currentPermissionMode;
      await saveConfig();
    }
    return currentPermissionMode;
  });

  ipcMain.handle('config:delete-provider', async (_event, id: string) => {
    const cfg = getConfig();
    cfg.providers = cfg.providers.filter(p => p.id !== id);
    if (cfg.activeProvider === id) {
      cfg.activeProvider = cfg.providers[0]?.id || 'deepseek';
    }
    await saveConfig();
  });

  // ---- Agents ----
  ipcMain.handle('agents:list', () => {
    return getAgents();
  });

  ipcMain.handle('agents:save', async (_event, agent: AgentConfig) => {
    saveAgent(agent);
    await saveConfig();
  });

  ipcMain.handle('agents:delete', async (_event, agentId: string) => {
    deleteAgent(agentId);
    await saveConfig();
  });

  // ---- Session persistence (SQLite) ----
  ipcMain.handle('session:save', async (_event, session: SessionData) => {
    const agent = sessionAgents.get(session.id);
    saveSession({
      ...session,
      agentMessages: agent ? agent.getMessages() : session.agentMessages,
      updatedAt: session.updatedAt || Date.now(),
      costState: getCostStateSnapshot(),
    } as any);
  });

  ipcMain.handle('session:load', async (_event, id: string) => {
    const session = loadSession(id);
    if (session && (session as any).costState) {
      restoreCostState((session as any).costState);
    }
    // Emit updated cost to frontend
    getWindow()?.webContents.send('cost:updated', getCostSummary());
    return session;
  });

  ipcMain.handle('session:list', async () => {
    return listSessions();
  });

  ipcMain.handle('session:delete', async (_event, id: string) => {
    sessionAbortControllers.get(id)?.abort();
    sessionAbortControllers.delete(id);
    sessionAgents.delete(id);
    sessionModels.delete(id);
    sessionCompactMeta.delete(id);
    clearQueuedTurns(id);
    cancelPendingInteractionsForSession(id, 'Session deleted');
    closeCollabForSession(id);
    deleteSession(id);
  });

  ipcMain.handle('session:rename', async (_event, id: string, newTitle: string) => {
    return renameSession(id, newTitle);
  });

  ipcMain.handle('session:set-pinned', async (_event, id: string, pinned: boolean) => {
    return setSessionPinned(id, pinned);
  });

  ipcMain.handle('session-groups:list', async () => {
    return listSessionGroups();
  });

  ipcMain.handle('session-groups:create', async (_event, name?: string) => {
    return createSessionGroup(name || '新建组');
  });

  ipcMain.handle('session-groups:rename', async (_event, id: string, name: string) => {
    return renameSessionGroup(id, name);
  });

  ipcMain.handle('session-groups:set-pinned', async (_event, id: string, pinned: boolean) => {
    return setSessionGroupPinned(id, pinned);
  });

  ipcMain.handle('session-groups:set-collapsed', async (_event, id: string, collapsed: boolean) => {
    return setSessionGroupCollapsed(id, collapsed);
  });

  ipcMain.handle('session-groups:assign-session', async (_event, sessionId: string, groupId: string | null) => {
    return setSessionGroup(sessionId, groupId || null);
  });

  ipcMain.handle('session-groups:delete', async (_event, id: string) => {
    return deleteSessionGroup(id);
  });

  ipcMain.handle('session:generate-title', async (_event, userMessage: string) => {
    try {
      const p = getProvider();
      if (!p) return null;

      const result = await p.runStep({
        messages: [
          { role: 'system', content: 'Generate a very short title (4-6 words max) for a conversation. Reply with ONLY the title, no quotes, no explanation. Use the user\'s language.' },
          { role: 'user', content: userMessage.slice(0, 500) },
        ],
        tools: [],
        model: 'default',
      });

      const title = result.text.trim().slice(0, 80);
      return title || null;
    } catch {
      return null;
    }
  });

  // ---- CLAUDE.md ----
  ipcMain.handle('agent-md:reload', async () => {
    const result = await discoverAgentMd(getConfig().agent.workspaceRoot);
    agentMdContent = result.content;
    agentMdFiles = result.files;
    return result.files;
  });

  ipcMain.handle('agent-md:get', () => {
    return { content: agentMdContent, files: agentMdFiles };
  });

  ipcMain.handle('memory:list', async () => {
    const { resolve } = require('path');
    const memDirs = [
      join(getConfig().agent.workspaceRoot, APP_DATA_DIR_NAME, 'memory'),
      join(getConfig().agent.workspaceRoot, LEGACY_APP_DATA_DIR_NAME, 'memory'),
      join(userDataDir(), 'memory'),
      join(legacyUserDataDir(), 'memory'),
    ];
    // Deduplicate
    const seen = new Set<string>();
    const dirs = memDirs.filter(d => { const r = resolve(d); if (seen.has(r)) return false; seen.add(r); return true; });
    const results: Array<{ name: string; path: string }> = [];
    for (const memDir of dirs) {
      try {
        const entries = await fs.readdir(memDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.md')) {
            results.push({ name: e.name.replace('.md', ''), path: join(memDir, e.name) });
          }
        }
      } catch { /* dir not found */ }
    }
    return results;
  });

  ipcMain.handle('memory:read', async (_event, filePath: string) => {
    // Memory files are outside workspace — allow direct read
    return await fs.readFile(filePath, 'utf8');
  });

  ipcMain.handle('memory:delete', async (_event, filePath: string) => {
    // Prevent deleting AGENT.md
    if (filePath.toLowerCase().endsWith('agent.md')) {
      throw new Error('AGENT.md cannot be deleted');
    }
    try {
      await fs.unlink(filePath);
    } catch (err) {
      throw new Error(`Failed to delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ipcMain.handle('memory:write', async (_event, filePath: string, content: string) => {
    await fs.writeFile(filePath, content, 'utf8');
  });

  // ---- Skills ----
  ipcMain.handle('skills:reload', async () => {
    const root = getConfig().agent.workspaceRoot;
    await Promise.all([
      loadSkills(root),
      discoverAgentMd(root).then(r => { agentMdContent = r.content; agentMdFiles = r.files; }),
    ]);
    return getLoadedSkills().map(s => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      argumentHint: s.argumentHint,
      userInvocable: s.userInvocable,
    }));
  });

  ipcMain.handle('skills:list', () => {
    return getLoadedSkills().map(s => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      argumentHint: s.argumentHint,
      userInvocable: s.userInvocable,
    }));
  });

  ipcMain.handle('skills:invoke', async (_event, skillName: string) => {
    // Reload skills to ensure freshness
    await loadSkills(getConfig().agent.workspaceRoot);
    const { skillHandlers } = require('./tools/skill-tools');
    return skillHandlers.invoke_skill({ skill: skillName });
  });

  ipcMain.handle('skills:write-content', async (_event, skillName: string, content: string) => {
    await loadSkills(getConfig().agent.workspaceRoot);
    const { getSkill } = require('./skills/loader');
    const skill = getSkill(skillName);
    if (!skill) return false;
    await fs.writeFile(join(skill.rootDir, 'SKILL.md'), content, 'utf8');
    await loadSkills(getConfig().agent.workspaceRoot);
    return true;
  });

  ipcMain.handle('skills:delete', async (_event, skillName: string) => {
    await loadSkills(getConfig().agent.workspaceRoot);
    const { getSkill } = require('./skills/loader');
    const skill = getSkill(skillName);
    if (!skill) throw new Error('Skill not found');
    await fs.rm(skill.rootDir, { recursive: true });
    await loadSkills(getConfig().agent.workspaceRoot);
    return true;
  });

  // ---- Dialog ----
  ipcMain.handle('dialog:pick-dir', async () => {
    const win = getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择工作区目录',
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  // ---- Terminal ----
  let termProcess: ChildProcess | null = null;

  ipcMain.handle('terminal:start', () => {
    if (termProcess) return true;

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    termProcess = spawn(shell, [], {
      cwd: getConfig().agent.workspaceRoot,
      env: process.env,
    });

    termProcess.stdout?.on('data', (data: Buffer) => {
      getWindow()?.webContents.send('terminal:data', data.toString());
    });

    termProcess.stderr?.on('data', (data: Buffer) => {
      getWindow()?.webContents.send('terminal:data', data.toString());
    });

    termProcess.on('exit', () => {
      getWindow()?.webContents.send('terminal:data', '\r\n[Process exited]');
      termProcess = null;
    });

    return true;
  });

  ipcMain.handle('terminal:write', (_event, text: string) => {
    if (termProcess?.stdin?.writable) {
      termProcess.stdin.write(text);
    }
  });

  // ---- Window controls ----
  ipcMain.handle('window:minimize', () => getWindow()?.minimize());
  ipcMain.handle('window:maximize', () => {
    const w = getWindow();
    if (w?.isMaximized()) w.unmaximize();
    else w?.maximize();
  });
  ipcMain.handle('window:close', () => getWindow()?.close());

  // ---- Cost Tracking IPC ----
  // ---- Plan Mode ----
  ipcMain.handle('plan-mode:status', () => isPlanMode());
  ipcMain.handle('plan-mode:toggle', async () => {
    if (isPlanMode()) {
      exitPlanMode();
      currentPermissionMode = 'default';
    } else {
      enterPlanMode();
      currentPermissionMode = 'plan';
    }
    const cfg = getConfig();
    cfg.permissionMode = currentPermissionMode;
    await saveConfig();
    return isPlanMode();
  });

  ipcMain.handle('session-memory:get', async () => {
    return getSessionMemoryContent(getConfig().agent.workspaceRoot);
  });

  ipcMain.handle('session-memory:get-layered', async () => {
    return getLayeredMemoryContent(getConfig().agent.workspaceRoot);
  });

  ipcMain.handle('session-memory:reload', async () => {
    return preloadLayeredMemoryContent(getConfig().agent.workspaceRoot);
  });

  ipcMain.handle('tasks:list', () => listTasksSnapshot());
  onTasksChanged((tasks) => {
    getWindow()?.webContents.send('tasks:updated', tasks);
  });

  ipcMain.handle('cost:summary', () => getCostSummary());
  ipcMain.handle('cost:reset', () => { resetCostState(); return getCostSummary(); });

  ipcMain.handle('terminal:stop', () => {
    termProcess?.kill();
    termProcess = null;
  });
}

export async function initAgentMd(): Promise<void> {
  const result = await discoverAgentMd(getConfig().agent.workspaceRoot);
  agentMdContent = result.content;
  agentMdFiles = result.files;
  await preloadLayeredMemoryContent(getConfig().agent.workspaceRoot).catch(() => {});
}

export async function initSkills(): Promise<void> {
  // Skills are already loaded in main/index.ts
}

export { getLoadedSkills } from './skills/loader';

// Re-export for main/index.ts
export { getConfig, setConfig, saveConfig } from './config';
