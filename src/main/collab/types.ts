import type { CollabCodexModel } from '../../shared/collab';

export type CollabAgentRole = 'neck' | 'codex' | 'claude';

export type CollabTaskStatus =
  | 'created'
  | 'planning_codex'
  | 'planned'
  | 'executing_claude'
  | 'executed'
  | 'reviewing_codex'
  | 'needs_fix'
  | 'approved'
  | 'failed'
  | 'cancelled';

export type CollabRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type CollabArtifactType =
  | 'brief'
  | 'codex_plan_log'
  | 'claude_log'
  | 'result'
  | 'diff'
  | 'test_output'
  | 'codex_review_log'
  | 'review'
  | 'status';

export interface CollabConfig {
  enabled: boolean;
  codexCommand: string;
  claudeCommand: string;
  codexModel: CollabCodexModel;
  claudeModel: string;
  codexEffort: 'minimal' | 'low' | 'medium' | 'high';
  writePolicy: 'workspaceLock';
}

export interface CollabSessionRow {
  id: string;
  neck_session_id: string;
  workspace_root: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface CollabTaskRow {
  id: string;
  collab_session_id: string;
  user_message: string;
  status: CollabTaskStatus;
  current_phase: string;
  created_at: number;
  updated_at: number;
}

export interface CollabRunRow {
  id: string;
  task_id: string;
  agent_role: CollabAgentRole;
  executor: string;
  model: string | null;
  cli_session_id: string | null;
  status: CollabRunStatus;
  started_at: number | null;
  ended_at: number | null;
}

export interface CollabArtifactRow {
  id: string;
  task_id: string;
  type: CollabArtifactType;
  path: string;
  created_at: number;
}

export interface CollabAgentStatus {
  role: CollabAgentRole;
  label: string;
  model?: string;
  phase: string;
  status: CollabRunStatus | 'idle';
  message?: string;
  runId?: string;
  startedAt?: number | null;
  endedAt?: number | null;
}

export interface CollabTaskView {
  id: string;
  sessionId: string;
  collabSessionId: string;
  userMessage: string;
  status: CollabTaskStatus;
  currentPhase: string;
  createdAt: number;
  updatedAt: number;
  agents: CollabAgentStatus[];
  artifacts: Array<{ type: CollabArtifactType; path: string; createdAt: number }>;
  lastEvent?: CollabEvent;
}

export interface CollabSessionStatus {
  enabled: boolean;
  sessionId: string;
  collabSessionId?: string;
  workspaceRoot: string;
  status?: string;
  activeTask?: CollabTaskView | null;
  locked: boolean;
}

export interface CollabEvent {
  id?: string;
  sessionId: string;
  collabSessionId?: string;
  taskId?: string;
  runId?: string;
  agentRole: CollabAgentRole;
  type: string;
  phase: string;
  status?: CollabTaskStatus | CollabRunStatus | string;
  model?: string;
  message?: string;
  artifactType?: CollabArtifactType;
  artifactPath?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface CliRunResult {
  exitCode: number | null;
  output: string;
  errorOutput: string;
}
