import type { AgentConfig, AgentError, CollabCliCheckResult, CollabConfig, CollabEvent, ConfirmRequest, ProviderTestConfig, ProviderTestResult, RunStatusEvent } from './types';
import type { ImAuthState, ImConversation, ImFriend, ImFriendRequest, ImMessage, ImMessageAttachment, ImSendMessageInput } from './im-types';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface AppConfigView {
  model: string;
  models: string[];
  activeProvider: string;
  providers: Array<{ id: string; name: string; models: string[] }>;
  workspaceRoot: string;
  maxTurns: number;
  maxTokens: number;
  baseUrl: string;
  theme?: 'light' | 'dark';
  lightScheme?: string;
  fontScale?: number;
  codeLeftWidth?: number;
  autoLaunch?: boolean;
  lastSeenReleaseNotesVersion?: string;
  version?: string;
  quickLauncher?: {
    enabled: boolean;
    triggerWindowMs: number;
    inputAutoHideMs: number;
    panelAutoHideMs: number;
    mode: 'chat' | 'find';
    modelId?: string;
    findMaxDepth?: number;
    favorites?: string[];
  };
  collab?: CollabConfig;
  deepseekApiKey?: string;
  anthropicApiKey?: string;
}

export interface QuickLauncherState {
  mode: 'chat' | 'find';
  inputAutoHideMs: number;
  panelAutoHideMs: number;
}

export interface QuickEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
}

export interface QuickFindResult {
  id?: string;
  path: string;
  name: string;
  isDir?: boolean;
  score: number;
  source?: string;
  mtimeMs?: number;
  favorite?: boolean;
}

export interface SendMessageResult {
  queued?: boolean;
  queuedId?: string;
  queuedCount?: number;
}

export interface SessionGroupView {
  id: string;
  name: string;
  createdAt?: number;
  updatedAt?: number;
  pinnedAt?: number | null;
  collapsed?: boolean;
}

export interface ImFriendsResult {
  friends: ImFriend[];
  requests: ImFriendRequest[];
  error?: unknown;
}

export interface ImConversationsResult {
  conversations: ImConversation[];
  error?: unknown;
}

export type Unsubscribe = () => void;

export interface CostSummary {
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalWebSearchRequests: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
    costUSD: number;
  }>;
}

export interface ElectronAPI {
  sendMessage: (sessionId: string, text: string, attachments?: { type: string; data: string; mimeType: string }[]) => Promise<SendMessageResult>;
  regenerate: (sessionId: string, text: string, attachments?: { type: string; data: string; mimeType: string }[]) => Promise<unknown>;
  abort: (sessionId: string) => Promise<void>;
  resetAgent: (sessionId: string) => Promise<void>;
  setAgentContext: (sessionId: string, messages: unknown[], modelId?: string) => Promise<void>;
  getAgentContextStatus: (sessionId: string) => Promise<unknown>;
  refreshAgentContextStatus: (sessionId: string) => Promise<unknown>;
  setSessionModel: (sessionId: string, modelId: string) => Promise<void>;

  onDelta: (cb: (sid: string, text: string) => void) => Unsubscribe;
  onThinkingDelta: (cb: (sid: string, text: string) => void) => Unsubscribe;
  onToolStart: (cb: (sid: string, data: unknown) => void) => Unsubscribe;
  onToolResult: (cb: (sid: string, data: unknown) => void) => Unsubscribe;
  onToolSummary: (cb: (sid: string, data: unknown) => void) => Unsubscribe;
  onTurnDone: (cb: (sid: string, data: unknown) => void) => Unsubscribe;
  onRunStatus: (cb: (sid: string, status: RunStatusEvent) => void) => Unsubscribe;
  onQueuedMessageStart: (cb: (sid: string, data: unknown) => void) => Unsubscribe;
  onQueuedCount: (cb: (sid: string, count: number) => void) => Unsubscribe;
  onError: (cb: (sid: string, error: string | AgentError) => void) => Unsubscribe;

  getCollabConfig: () => Promise<CollabConfig>;
  setCollabConfig: (config: Partial<CollabConfig>) => Promise<CollabConfig>;
  checkCollabCli: (config?: Partial<CollabConfig>) => Promise<CollabCliCheckResult>;
  getCollabSessionStatus: (sessionId: string) => Promise<unknown>;
  listCollabTasks: (sessionId: string) => Promise<unknown[]>;
  abortCollabTask: (taskId: string) => Promise<void>;
  retryCollabTask: (taskId: string, phase?: string) => Promise<unknown>;
  approveCollabTask: (taskId: string) => Promise<unknown>;
  readCollabArtifact: (taskId: string, artifactId: string) => Promise<unknown>;
  onCollabEvent: (cb: (event: CollabEvent) => void) => Unsubscribe;
  onCollabConfigUpdated: (cb: (config: CollabConfig) => void) => Unsubscribe;

  getConfig: () => Promise<AppConfigView>;
  setConfig: (key: string, value: unknown) => Promise<void>;
  getProviders: () => Promise<unknown[]>;
  setProvider: (config: unknown) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  testProvider: (config: ProviderTestConfig) => Promise<ProviderTestResult>;
  getDeepSeekBalance: () => Promise<unknown>;
  getProviderBalance: (providerId: string) => Promise<unknown>;

  listDir: (dirPath: string) => Promise<FileEntry[]>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;

  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  setAlwaysOnTop: (enabled: boolean) => Promise<boolean>;
  getAlwaysOnTop: () => Promise<boolean>;
  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<boolean>;

  // Pet
  getPetStatus: () => Promise<boolean>;
  togglePet: () => Promise<boolean>;
  getPetTheme: () => Promise<string>;
  setPetTheme: (theme: string) => Promise<string>;

  quickLauncherShow: () => Promise<void>;
  quickLauncherHide: () => Promise<void>;
  quickLauncherToggle: () => Promise<void>;
  quickLauncherGetState: () => Promise<QuickLauncherState>;
  quickLauncherSetMode: (mode: 'chat' | 'find') => Promise<void>;
  quickLauncherSetExpanded: (expanded: boolean) => Promise<void>;
  onQuickLauncherShow: (cb: () => void) => Unsubscribe;
  onQuickLauncherHide: (cb: () => void) => Unsubscribe;
  quickChatSend: (message: string) => Promise<{ ok?: boolean; error?: string }>;
  quickChatAbort: () => Promise<void>;
  quickChatClear: () => Promise<void>;
  quickChatSaveSession: () => Promise<{ ok?: boolean; sessionId?: string; error?: string }>;
  onQuickChatUser: (cb: (entry: QuickEntry) => void) => Unsubscribe;
  onQuickChatDelta: (cb: (text: string) => void) => Unsubscribe;
  onQuickChatDone: (cb: (data: { text?: string }) => void) => Unsubscribe;
  onQuickChatRunStatus: (cb: (status: RunStatusEvent) => void) => Unsubscribe;
  onQuickChatToolStart: (cb: (entry: QuickEntry) => void) => Unsubscribe;
  onQuickChatToolResult: (cb: (data: { toolCallId?: string; result?: string }) => void) => Unsubscribe;
  onQuickChatError: (cb: (error: { message?: string; suggestion?: string }) => void) => Unsubscribe;
  onQuickChatCleared: (cb: () => void) => Unsubscribe;
  onQuickChatSaved: (cb: (data: { sessionId?: string }) => void) => Unsubscribe;
  onQuickChatSaveError: (cb: (data: { message?: string }) => void) => Unsubscribe;
  quickFindLocalSearch: (query: string, favoritesList?: string[]) => Promise<QuickFindResult[]>;
  quickFindAgentSearch: (query: string) => Promise<QuickFindResult[]>;
  quickFindOpen: (path: string, reveal?: boolean) => Promise<{ ok?: boolean; error?: string }>;
  quickFindReadFile: (path: string) => Promise<{ ok?: boolean; content?: string; size?: number; error?: string }>;
  clipboardWrite: (text: string) => Promise<void>;
  clipboardRead: () => Promise<string>;

  startTerminal: () => Promise<void>;
  writeTerminal: (text: string) => Promise<void>;
  stopTerminal: () => Promise<void>;
  onTerminalData: (cb: (data: string) => void) => Unsubscribe;

  saveSession: (session: unknown) => Promise<void>;
  loadSession: (id: string) => Promise<unknown>;
  listSessions: () => Promise<unknown[]>;
  onSessionSaved: (cb: (data: unknown) => void) => Unsubscribe;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string, updatedAt?: number) => Promise<boolean>;
  setSessionPinned: (id: string, pinned: boolean) => Promise<boolean>;
  listSessionGroups: () => Promise<SessionGroupView[]>;
  createSessionGroup: (name?: string) => Promise<SessionGroupView>;
  renameSessionGroup: (id: string, name: string) => Promise<boolean>;
  setSessionGroupPinned: (id: string, pinned: boolean) => Promise<boolean>;
  setSessionGroupCollapsed: (id: string, collapsed: boolean) => Promise<boolean>;
  assignSessionGroup: (sessionId: string, groupId: string | null) => Promise<boolean>;
  deleteSessionGroup: (id: string) => Promise<boolean>;
  generateTitle: (message: string) => Promise<string | null>;

  listSkills: () => Promise<Array<{ name: string; description: string; whenToUse?: string; argumentHint?: string; userInvocable: boolean }>>;
  reloadSkills: () => Promise<unknown[]>;
  invokeSkill: (name: string) => Promise<string>;
  writeSkillContent: (name: string, content: string) => Promise<boolean>;
  deleteSkill: (name: string) => Promise<boolean>;

  listAgents: () => Promise<AgentConfig[]>;
  saveAgent: (agent: AgentConfig) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;

  getAgentMd: () => Promise<{ content: string; files: string[] }>;
  listMemory: () => Promise<Array<{ name: string; path: string }>>;
  readMemory: (path: string) => Promise<string>;
  writeMemory: (path: string, content: string) => Promise<void>;
  deleteMemory: (path: string) => Promise<void>;
  getSessionMemory: () => Promise<string>;
  getLayeredMemory: () => Promise<{ session: string; project: string; user: string }>;
  reloadSessionMemory: () => Promise<{ session: string; project: string; user: string }>;
  listTasks: () => Promise<Array<{ id: string; subject: string; description: string; status: string; activeForm?: string; blocks: string[]; blockedBy: string[]; createdAt: number; completedAt?: number }>>;
  onTasksUpdated: (cb: (tasks: Array<{ id: string; subject: string; description: string; status: string; activeForm?: string; blocks: string[]; blockedBy: string[]; createdAt: number; completedAt?: number }>) => void) => Unsubscribe;

  onAskShow: (cb: (sessionId: string, askId: string, questions: unknown[]) => void) => Unsubscribe;
  respondToAsk: (askId: string, answers: Record<string, string> | null) => Promise<void>;
  onConfirmShow: (cb: (sessionId: string, confirmId: string, request: string | ConfirmRequest) => void) => Unsubscribe;
  respondToConfirm: (confirmId: string, approved: boolean) => Promise<void>;

  pickDirectory: () => Promise<string | null>;
  getPermissionMode: () => Promise<string>;
  setPermissionMode: (mode: string) => Promise<void>;
  onCloseAsk: (cb: () => void) => Unsubscribe;
  closeChoice: (action: string, remember: boolean, autoLaunch?: boolean) => Promise<void>;

  imConnect: (serverUrl?: string) => Promise<unknown>;
  imDisconnect: () => Promise<unknown>;
  imGetAuthState: () => Promise<ImAuthState>;
  imRegister: (input: unknown) => Promise<unknown>;
  imLogin: (input: unknown) => Promise<unknown>;
  imLogout: () => Promise<unknown>;
  imSearchUsers: (query: unknown) => Promise<unknown>;
  imListFriends: () => Promise<ImFriendsResult>;
  imAddFriend: (userId: unknown) => Promise<unknown>;
  imAcceptFriend: (userId: unknown) => Promise<unknown>;
  imRemoveFriend: (userId: unknown) => Promise<unknown>;
  imSendMessage: (input: ImSendMessageInput) => Promise<unknown>;
  imListMessages: (peerUserId: string, options?: unknown) => Promise<ImMessage[]>;
  imLoadHistory: (peerUserId: string, options?: unknown) => Promise<unknown>;
  imMarkRead: (messageId: string, fromUser?: string) => Promise<unknown>;
  imListConversations: () => Promise<ImConversationsResult>;
  imClearUnread: (peerUserId: string) => Promise<unknown>;
  onImAuthState: (cb: (state: ImAuthState) => void) => Unsubscribe;
  onImConnectionState: (cb: (state: unknown) => void) => Unsubscribe;
  onImFriendsUpdated: (cb: (data: unknown) => void) => Unsubscribe;
  onImFriendRequest: (cb: (data: unknown) => void) => Unsubscribe;
  onImMessageNew: (cb: (data: unknown) => void) => Unsubscribe;
  onImMessageUpdated: (cb: (data: unknown) => void) => Unsubscribe;
  onImConversationUpdated: (cb: (data: unknown) => void) => Unsubscribe;
  onImPresence: (cb: (data: unknown) => void) => Unsubscribe;
  onImError: (cb: (data: unknown) => void) => Unsubscribe;

  onUpdateAvailable: (cb: (version: string) => void) => Unsubscribe;
  onUpdateProgress: (cb: (pct: number) => void) => Unsubscribe;
  onUpdateDownloaded: (cb: () => void) => Unsubscribe;
  checkForUpdates: () => Promise<{ version?: string; error?: string }>;
  downloadUpdate: () => Promise<{ ok?: boolean; error?: string }>;
  installUpdate: () => void;

  // Cost Tracking
  getCostSummary: () => Promise<CostSummary>;
  resetCost: () => Promise<CostSummary>;
  onCostUpdated: (cb: (data: CostSummary) => void) => Unsubscribe;
}
