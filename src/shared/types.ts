import type { CollabCodexModel } from './collab';

// --- Messages ---

export interface ToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export interface AssistantStep {
  text: string;
  toolCalls: ToolCall[];
}

export interface Attachment {
  type: 'image';
  mimeType: string;
  data: string; // base64
  filename?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  attachments?: Attachment[];
  createdAt: number;
}

// --- Sessions ---

export interface Session {
  id: string;
  title: string;
  projectPath: string;
  providerId: string;
  modelId: string;
  createdAt: number;
  updatedAt: number;
}

// --- Providers ---

export interface ProviderConfig {
  id: string;
  name: string;
  type: 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  models: string[];
}

// --- Agent Panel ---

export interface AgentConfig {
  id: string;
  name: string;
  memory: string;
  skills: string[];
  model: string;
}

// ---

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  readOnly?: boolean;
}

// --- Runtime Observability ---

export type RunPhase =
  | 'idle'
  | 'starting'
  | 'requesting_model'
  | 'thinking'
  | 'streaming'
  | 'tool_running'
  | 'waiting_user'
  | 'finishing'
  | 'aborted'
  | 'error';

export interface RunState {
  phase: RunPhase;
  startedAt: number | null;
  lastEventAt: number | null;
  currentTool?: string | null;
  lastTool?: string | null;
  inputTokens: number;
  outputTokens: number;
  currentTokens: number;
  estimatedTokens: number;
  contextLimit: number;
  effectiveWindow: number;
  reservedOutputTokens: number;
  autoCompactThreshold: number;
  autoCompactBufferTokens: number;
  blockingThreshold: number;
  freeTokens: number;
  percentUsed: number;
  willAutoCompact: boolean;
  contextSource?: 'usage' | 'estimate';
  compacting?: boolean;
  compacted?: boolean;
  lastCompactAt?: number | null;
  compactCount?: number;
  compactError?: string | null;
  consecutiveCompactFailures?: number;
  errorCode?: AgentErrorCode | null;
}

export type AgentErrorCode =
  | 'auth_error'
  | 'network_error'
  | 'rate_limited'
  | 'model_not_found'
  | 'context_limit'
  | 'tool_error'
  | 'permission_denied'
  | 'aborted'
  | 'unknown';

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  suggestion: string;
  retryable: boolean;
  providerId?: string;
  model?: string;
  raw?: string;
}

export interface RunStatusEvent extends Partial<RunState> {
  phase: RunPhase;
}

// --- Model Collaboration ---

export interface CollabConfig {
  enabled: boolean;
  codexCommand: string;
  claudeCommand: string;
  codexModel: CollabCodexModel;
  claudeModel: string;
  codexEffort: 'minimal' | 'low' | 'medium' | 'high';
  writePolicy: 'workspaceLock';
}

export interface CollabCliCheckItem {
  command: string;
  ok: boolean;
  version?: string;
  error?: string;
}

export interface CollabCliCheckResult {
  ok: boolean;
  codex: CollabCliCheckItem;
  claude: CollabCliCheckItem;
}

export interface CollabEvent {
  sessionId: string;
  collabSessionId?: string;
  taskId?: string;
  runId?: string;
  agentRole: 'neck' | 'codex' | 'claude';
  type: string;
  phase: string;
  status?: string;
  model?: string;
  message?: string;
  artifactType?: string;
  artifactPath?: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

// --- Permission / Confirmation ---

export type RiskLevel = 'low' | 'medium' | 'high';

export interface ConfirmRequest {
  toolName: string;
  riskLevel: RiskLevel;
  summary: string;
  cwd?: string;
  command?: string;
  paths?: string[];
  warnings?: string[];
  rawArgs?: Record<string, unknown>;
}

// --- Provider Diagnostics ---

export interface ProviderTestConfig {
  providerId?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
}

export type ProviderTestStatus = 'pass' | 'warn' | 'fail';

export interface ProviderTestCheck {
  id: string;
  label: string;
  status: ProviderTestStatus;
  message: string;
}

export interface ProviderTestResult {
  status: ProviderTestStatus;
  summary: string;
  checks: ProviderTestCheck[];
  suggestion?: string;
  balance?: {
    total: string;
    toppedUp?: string;
    granted?: string;
    currency: string;
  };
}
