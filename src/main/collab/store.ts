import { randomUUID } from 'crypto';
import { getDb } from '../session-store';
import type {
  CollabAgentRole,
  CollabAgentStatus,
  CollabArtifactRow,
  CollabArtifactType,
  CollabEvent,
  CollabRunRow,
  CollabRunStatus,
  CollabSessionRow,
  CollabSessionStatus,
  CollabTaskRow,
  CollabTaskStatus,
  CollabTaskView,
} from './types';

function now(): number {
  return Date.now();
}

function ensureSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS collab_sessions (
      id TEXT PRIMARY KEY,
      neck_session_id TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_sessions_neck_workspace
      ON collab_sessions(neck_session_id, workspace_root);

    CREATE TABLE IF NOT EXISTS collab_tasks (
      id TEXT PRIMARY KEY,
      collab_session_id TEXT NOT NULL,
      user_message TEXT NOT NULL,
      status TEXT NOT NULL,
      current_phase TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collab_tasks_session_updated
      ON collab_tasks(collab_session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS collab_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      executor TEXT NOT NULL,
      model TEXT,
      cli_session_id TEXT,
      status TEXT NOT NULL,
      started_at INTEGER,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_collab_runs_task ON collab_runs(task_id);

    CREATE TABLE IF NOT EXISTS collab_events (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      run_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collab_events_task_created
      ON collab_events(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS collab_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_collab_artifacts_task ON collab_artifacts(task_id);

    CREATE TABLE IF NOT EXISTS collab_locks (
      id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      task_id TEXT NOT NULL,
      lock_type TEXT NOT NULL,
      acquired_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_collab_locks_workspace_type
      ON collab_locks(workspace_root, lock_type);
  `);
}

function parseEvent(row: { id: string; payload_json: string; created_at: number } | undefined): CollabEvent | undefined {
  if (!row) return undefined;
  try {
    return { id: row.id, ...(JSON.parse(row.payload_json) as CollabEvent), createdAt: row.created_at };
  } catch {
    return undefined;
  }
}

function labelForRole(role: CollabAgentRole): string {
  if (role === 'codex') return 'Codex Worker';
  if (role === 'claude') return 'Claude Code Worker';
  return 'Neck Coordinator';
}

function phaseForRole(role: CollabAgentRole, task: CollabTaskRow): string {
  if (role === 'codex') {
    return task.status === 'reviewing_codex' || task.status === 'needs_fix' || task.status === 'approved'
      ? 'review'
      : 'plan';
  }
  if (role === 'claude') return 'execute';
  return 'coordinate';
}

function taskToView(task: CollabTaskRow, session: CollabSessionRow): CollabTaskView {
  ensureSchema();
  const runs = getDb()
    .prepare('SELECT * FROM collab_runs WHERE task_id = ? ORDER BY started_at ASC, id ASC')
    .all(task.id) as CollabRunRow[];
  const artifacts = getDb()
    .prepare('SELECT * FROM collab_artifacts WHERE task_id = ? ORDER BY created_at ASC')
    .all(task.id) as CollabArtifactRow[];
  const lastEvent = parseEvent(getDb()
    .prepare('SELECT id, payload_json, created_at FROM collab_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(task.id) as { id: string; payload_json: string; created_at: number } | undefined);

  const roles: CollabAgentRole[] = ['neck', 'codex', 'claude'];
  const agents: CollabAgentStatus[] = roles.map(role => {
    const roleRuns = runs.filter(run => run.agent_role === role);
    const latest = roleRuns.at(-1);
    return {
      role,
      label: labelForRole(role),
      model: latest?.model || undefined,
      phase: latest ? phaseForRole(role, task) : 'idle',
      status: latest?.status || 'idle',
      message: latest?.executor,
      runId: latest?.id,
      startedAt: latest?.started_at || null,
      endedAt: latest?.ended_at || null,
    };
  });

  return {
    id: task.id,
    sessionId: session.neck_session_id,
    collabSessionId: task.collab_session_id,
    userMessage: task.user_message,
    status: task.status,
    currentPhase: task.current_phase,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    agents,
    artifacts: artifacts.map(item => ({ type: item.type, path: item.path, createdAt: item.created_at })),
    lastEvent,
  };
}

export function ensureCollabSession(neckSessionId: string, workspaceRoot: string): CollabSessionRow {
  ensureSchema();
  const existing = getDb()
    .prepare('SELECT * FROM collab_sessions WHERE neck_session_id = ? AND workspace_root = ?')
    .get(neckSessionId, workspaceRoot) as CollabSessionRow | undefined;
  if (existing) return existing;
  const ts = now();
  const row: CollabSessionRow = {
    id: randomUUID(),
    neck_session_id: neckSessionId,
    workspace_root: workspaceRoot,
    status: 'active',
    created_at: ts,
    updated_at: ts,
  };
  getDb().prepare(`
    INSERT INTO collab_sessions (id, neck_session_id, workspace_root, status, created_at, updated_at)
    VALUES (@id, @neck_session_id, @workspace_root, @status, @created_at, @updated_at)
  `).run(row);
  return row;
}

export function getCollabSession(neckSessionId: string, workspaceRoot?: string): CollabSessionRow | undefined {
  ensureSchema();
  if (workspaceRoot) {
    return getDb()
      .prepare('SELECT * FROM collab_sessions WHERE neck_session_id = ? AND workspace_root = ?')
      .get(neckSessionId, workspaceRoot) as CollabSessionRow | undefined;
  }
  return getDb()
    .prepare('SELECT * FROM collab_sessions WHERE neck_session_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(neckSessionId) as CollabSessionRow | undefined;
}

export function createTask(collabSessionId: string, userMessage: string): CollabTaskRow {
  ensureSchema();
  const ts = now();
  const row: CollabTaskRow = {
    id: randomUUID(),
    collab_session_id: collabSessionId,
    user_message: userMessage,
    status: 'created',
    current_phase: 'created',
    created_at: ts,
    updated_at: ts,
  };
  getDb().prepare(`
    INSERT INTO collab_tasks (id, collab_session_id, user_message, status, current_phase, created_at, updated_at)
    VALUES (@id, @collab_session_id, @user_message, @status, @current_phase, @created_at, @updated_at)
  `).run(row);
  return row;
}

export function updateTask(taskId: string, status: CollabTaskStatus, currentPhase = status): void {
  ensureSchema();
  getDb()
    .prepare('UPDATE collab_tasks SET status = ?, current_phase = ?, updated_at = ? WHERE id = ?')
    .run(status, currentPhase, now(), taskId);
}

export function getTask(taskId: string): CollabTaskRow | undefined {
  ensureSchema();
  return getDb().prepare('SELECT * FROM collab_tasks WHERE id = ?').get(taskId) as CollabTaskRow | undefined;
}

export function createRun(taskId: string, role: CollabAgentRole, executor: string, model?: string): CollabRunRow {
  ensureSchema();
  const row: CollabRunRow = {
    id: randomUUID(),
    task_id: taskId,
    agent_role: role,
    executor,
    model: model || null,
    cli_session_id: null,
    status: 'running',
    started_at: now(),
    ended_at: null,
  };
  getDb().prepare(`
    INSERT INTO collab_runs (id, task_id, agent_role, executor, model, cli_session_id, status, started_at, ended_at)
    VALUES (@id, @task_id, @agent_role, @executor, @model, @cli_session_id, @status, @started_at, @ended_at)
  `).run(row);
  return row;
}

export function updateRun(runId: string, status: CollabRunStatus, cliSessionId?: string | null): void {
  ensureSchema();
  getDb()
    .prepare('UPDATE collab_runs SET status = ?, cli_session_id = COALESCE(?, cli_session_id), ended_at = ? WHERE id = ?')
    .run(status, cliSessionId ?? null, status === 'running' || status === 'pending' ? null : now(), runId);
}

export function addArtifact(taskId: string, type: CollabArtifactType, path: string): void {
  ensureSchema();
  getDb().prepare(`
    INSERT INTO collab_artifacts (id, task_id, type, path, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), taskId, type, path, now());
}

export function appendEvent(event: CollabEvent): CollabEvent {
  ensureSchema();
  const row = {
    id: event.id || randomUUID(),
    task_id: event.taskId || null,
    run_id: event.runId || null,
    type: event.type,
    payload_json: JSON.stringify(event),
    created_at: event.createdAt || now(),
  };
  getDb().prepare(`
    INSERT INTO collab_events (id, task_id, run_id, type, payload_json, created_at)
    VALUES (@id, @task_id, @run_id, @type, @payload_json, @created_at)
  `).run(row);
  return { ...event, id: row.id, createdAt: row.created_at };
}

export function listTaskViews(neckSessionId: string): CollabTaskView[] {
  ensureSchema();
  const sessions = getDb()
    .prepare('SELECT * FROM collab_sessions WHERE neck_session_id = ? ORDER BY updated_at DESC')
    .all(neckSessionId) as CollabSessionRow[];
  const views: CollabTaskView[] = [];
  for (const session of sessions) {
    const tasks = getDb()
      .prepare('SELECT * FROM collab_tasks WHERE collab_session_id = ? ORDER BY updated_at DESC')
      .all(session.id) as CollabTaskRow[];
    for (const task of tasks) views.push(taskToView(task, session));
  }
  return views.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getTaskView(taskId: string): CollabTaskView | undefined {
  ensureSchema();
  const task = getTask(taskId);
  if (!task) return undefined;
  const session = getDb()
    .prepare('SELECT * FROM collab_sessions WHERE id = ?')
    .get(task.collab_session_id) as CollabSessionRow | undefined;
  return session ? taskToView(task, session) : undefined;
}

export function getSessionStatus(enabled: boolean, neckSessionId: string, workspaceRoot: string): CollabSessionStatus {
  ensureSchema();
  const session = getCollabSession(neckSessionId, workspaceRoot);
  const tasks = session ? listTaskViews(neckSessionId) : [];
  const activeTask = tasks.find(task => !['approved', 'failed', 'cancelled'].includes(task.status)) || tasks[0] || null;
  const locked = Boolean(getDb()
    .prepare('SELECT id FROM collab_locks WHERE workspace_root = ? AND lock_type = ? LIMIT 1')
    .get(workspaceRoot, 'write'));
  return {
    enabled,
    sessionId: neckSessionId,
    collabSessionId: session?.id,
    workspaceRoot,
    status: session?.status,
    activeTask,
    locked,
  };
}

export function tryAcquireWorkspaceLock(workspaceRoot: string, taskId: string): boolean {
  ensureSchema();
  try {
    getDb().prepare(`
      INSERT INTO collab_locks (id, workspace_root, task_id, lock_type, acquired_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), workspaceRoot, taskId, 'write', now());
    return true;
  } catch {
    return false;
  }
}

export function releaseWorkspaceLock(workspaceRoot: string, taskId?: string): void {
  ensureSchema();
  if (taskId) {
    getDb()
      .prepare('DELETE FROM collab_locks WHERE workspace_root = ? AND task_id = ? AND lock_type = ?')
      .run(workspaceRoot, taskId, 'write');
    return;
  }
  getDb()
    .prepare('DELETE FROM collab_locks WHERE workspace_root = ? AND lock_type = ?')
    .run(workspaceRoot, 'write');
}

export function closeSessionsForNeckSession(neckSessionId: string): void {
  ensureSchema();
  const sessions = getDb()
    .prepare('SELECT * FROM collab_sessions WHERE neck_session_id = ?')
    .all(neckSessionId) as CollabSessionRow[];
  const ts = now();
  const updateTaskStmt = getDb().prepare(`
    UPDATE collab_tasks SET status = 'cancelled', current_phase = 'cancelled', updated_at = ?
    WHERE collab_session_id = ? AND status NOT IN ('approved', 'failed', 'cancelled')
  `);
  for (const session of sessions) {
    updateTaskStmt.run(ts, session.id);
    getDb()
      .prepare('UPDATE collab_sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run('closed', ts, session.id);
    releaseWorkspaceLock(session.workspace_root);
  }
}
