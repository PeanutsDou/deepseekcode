import { create } from 'zustand';
import type { AgentError, AgentErrorCode, RunState, RunStatusEvent } from '../../shared/types';
import { useAppStore } from './app-store';

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  attachments?: { type: string; data: string; mimeType: string; name: string; size: number }[];
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  toolCallId?: string;
  timestamp: number;
  toolSummary?: Array<{ name: string; argumentsText: string; resultPreview: string }>;
  toolSummaryExpanded?: boolean;
}

export interface SessionState {
  entries: ChatEntry[];
  modelId?: string;
  isStreaming: boolean;
  streamingText: string;
  thinkingText: string;
  error: string | AgentError | null;
  pendingContext: string | null;
  runStartedAt: number | null;
  runState: RunState;
}

export type SessionStatus = 'idle' | 'running' | 'error';

interface ChatState {
  activeId: string | null;
  sessions: Record<string, SessionState>;
  focusVersion: number;

  addEntry: (entry: ChatEntry) => void;
  appendDelta: (text: string) => void;
  finishStream: (text: string) => void;
  setStreaming: (v: boolean) => void;
  setError: (msg: string | AgentError | null) => void;
  setPendingContext: (text: string | null) => void;
  triggerFocus: () => void;

  addEntryTo: (sid: string, entry: ChatEntry) => void;
  appendDeltaTo: (sid: string, text: string) => void;
  appendThinkingDeltaTo: (sid: string, text: string) => void;
  finishStreamTo: (sid: string, text: string) => void;
  setStreamingTo: (sid: string, v: boolean) => void;
  setErrorTo: (sid: string, msg: string | AgentError | null) => void;
  setRunStatusTo: (sid: string, status: RunStatusEvent) => void;
  setRunTokensTo: (sid: string, inputTokens: number, outputTokens: number) => void;
  trimEntriesFrom: (sid: string, fromIndex: number) => void;
  setSessionModelTo: (sid: string, modelId: string) => void;
  setEntryToolSummaryExpanded: (sid: string, entryId: string, expanded: boolean) => void;

  ensureActiveSession: () => string;
  startNew: (modelId?: string) => void;
  switchTo: (id: string) => void;
  loadEntries: (id: string, entries: ChatEntry[], modelId?: string) => void;
  removeSession: (id: string) => void;
  clearActive: () => void;
}

function emptyRunState(): RunState {
  return {
    phase: 'idle',
    startedAt: null,
    lastEventAt: null,
    currentTool: null,
    lastTool: null,
    inputTokens: 0,
    outputTokens: 0,
    currentTokens: 0,
    estimatedTokens: 0,
    contextLimit: 0,
    effectiveWindow: 0,
    reservedOutputTokens: 0,
    autoCompactThreshold: 0,
    autoCompactBufferTokens: 0,
    blockingThreshold: 0,
    freeTokens: 0,
    percentUsed: 0,
    willAutoCompact: false,
    contextSource: 'estimate',
    compacting: false,
    compacted: false,
    lastCompactAt: null,
    compactCount: 0,
    compactError: null,
    consecutiveCompactFailures: 0,
    errorCode: null,
  };
}

const EMPTY_RUN_STATE = emptyRunState();

function emptySession(modelId?: string): SessionState {
  return { entries: [], modelId, isStreaming: false, streamingText: '', thinkingText: '', error: null, pendingContext: null, runStartedAt: null, runState: emptyRunState() };
}

function updateSession(
  state: ChatState,
  id: string,
  updater: (ses: SessionState) => SessionState,
): ChatState {
  const ses = state.sessions[id] || emptySession();
  return {
    ...state,
    sessions: { ...state.sessions, [id]: updater(ses) },
  };
}

let currentSessionId: string | null = null;
const titlesGenerated = new Set<string>();

function createSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getSessionStatus(session?: SessionState): SessionStatus {
  if (!session) return 'idle';
  if (session.runState.phase === 'error') return 'error';
  if (['starting', 'requesting_model', 'thinking', 'streaming', 'tool_running', 'waiting_user', 'finishing'].includes(session.runState.phase)) return 'running';
  if (session.error) return 'error';
  if (session.isStreaming) return 'running';
  return 'idle';
}

async function autoSave(sessionId: string, entries: ChatEntry[], modelId?: string) {
  if (entries.length === 0) return;

  const firstUserMsg = entries.find(e => e.role === 'user')?.content || '';
  const isNew = !titlesGenerated.has(sessionId);
  const title = isNew ? (firstUserMsg.slice(0, 50) || 'Untitled') : undefined;
  const resolvedModelId = modelId
    || useChatStore.getState().sessions[sessionId]?.modelId
    || useAppStore.getState().currentModel;

  const sessionData: Record<string, unknown> = {
    id: sessionId,
    projectPath: '',
    modelId: resolvedModelId,
    messages: entries,
    updatedAt: Date.now(),
  };
  if (title) (sessionData as any).title = title;
  if (isNew) (sessionData as any).createdAt = Date.now();

  try {
    await window.electronAPI?.saveSession(sessionData);
    window.dispatchEvent(new CustomEvent('session-saved'));
    if (isNew) titlesGenerated.add(sessionId);
    if (isNew && firstUserMsg && window.electronAPI?.generateTitle) {
      window.electronAPI.generateTitle(firstUserMsg).then(aiTitle => {
        if (aiTitle) {
          window.electronAPI?.renameSession(sessionId, aiTitle);
          window.dispatchEvent(new CustomEvent('session-saved'));
        }
      }).catch(() => {});
    }
  } catch { /* */ }
}

export const useChatStore = create<ChatState>((set, get) => ({
  activeId: null,
  sessions: {},
  focusVersion: 0,

  addEntry(entry) {
    set(state => updateSession(state, state.activeId || 'default', ses => ({
      ...ses, entries: [...ses.entries, entry],
    })));
  },

  appendDelta(text) {
    set(state => updateSession(state, state.activeId || 'default', ses => ({
      ...ses, streamingText: ses.streamingText + text,
    })));
  },

  finishStream(text) {
    set(state => {
      const id = state.activeId || 'default';
      const ses = state.sessions[id] || emptySession();
      const finalText = text || ses.streamingText;
      const newEntries = [...ses.entries, { id: String(Date.now()), role: 'assistant' as const, content: finalText, timestamp: Date.now() }];
      autoSave(id, newEntries);
      return updateSession(state, id, s => ({
        ...s,
        entries: newEntries,
        streamingText: '',
        thinkingText: '',
        isStreaming: false,
        runStartedAt: null,
        runState: { ...s.runState, phase: 'idle', currentTool: null, lastEventAt: Date.now() },
      }));
    });
    // Auto-focus input after response
    set(s => ({ focusVersion: s.focusVersion + 1 }));
  },

  setStreaming(v) {
    set(state => updateSession(state, state.activeId || 'default', ses => ({
      ...ses,
      isStreaming: v,
      streamingText: v ? '' : ses.streamingText,
      thinkingText: v ? '' : ses.thinkingText,
      error: v ? null : ses.error,
      runStartedAt: v ? (ses.runStartedAt || Date.now()) : null,
      runState: v ? { ...emptyRunState(), phase: 'starting', startedAt: Date.now(), lastEventAt: Date.now() } : { ...ses.runState, phase: 'idle', currentTool: null, lastEventAt: Date.now() },
    })));
  },

  setError(msg) {
    set(state => updateSession(state, state.activeId || 'default', ses => ({
      ...ses,
      error: msg,
      isStreaming: false,
      runStartedAt: null,
      runState: { ...ses.runState, phase: msg ? 'error' : 'idle', currentTool: null, lastEventAt: Date.now() },
    })));
  },

  setPendingContext(text) {
    set(state => updateSession(state, state.activeId || 'default', ses => ({ ...ses, pendingContext: text })));
  },

  triggerFocus() {
    set(s => ({ focusVersion: s.focusVersion + 1 }));
  },

  addEntryTo(sid, entry) {
    set(state => {
      const ses = state.sessions[sid] || emptySession();
      const entries = [...ses.entries, entry];
      if (entry.role === 'user' || entry.role === 'tool') autoSave(sid, entries);
      return updateSession(state, sid, s => ({ ...s, entries, error: null }));
    });
  },

  appendDeltaTo(sid, text) {
    set(state => updateSession(state, sid, ses => (
      ses.isStreaming ? { ...ses, streamingText: ses.streamingText + text } : ses
    )));
  },

  appendThinkingDeltaTo(sid, text) {
    set(state => updateSession(state, sid, ses => (
      ses.isStreaming ? { ...ses, thinkingText: ses.thinkingText + text } : ses
    )));
  },

  finishStreamTo(sid, text) {
    set(state => {
      const ses = state.sessions[sid] || emptySession();
      const newEntries = [...ses.entries, { id: String(Date.now()), role: 'assistant' as const, content: text || ses.streamingText, timestamp: Date.now() }];
      autoSave(sid, newEntries);
      return updateSession(state, sid, s => ({
        ...s,
        entries: newEntries,
        streamingText: '',
        thinkingText: '',
        isStreaming: false,
        error: null,
        runStartedAt: null,
        runState: { ...s.runState, phase: 'idle', currentTool: null, lastEventAt: Date.now() },
      }));
    });
    set(s => ({ focusVersion: s.focusVersion + 1 }));
  },

  setStreamingTo(sid, v) {
    set(state => updateSession(state, sid, ses => ({
      ...ses,
      isStreaming: v,
      streamingText: v ? '' : ses.streamingText,
      thinkingText: v ? '' : ses.thinkingText,
      error: v ? null : ses.error,
      runStartedAt: v ? (ses.runStartedAt || Date.now()) : null,
      runState: v ? { ...emptyRunState(), phase: 'starting', startedAt: Date.now(), lastEventAt: Date.now() } : { ...ses.runState, phase: 'idle', currentTool: null, lastEventAt: Date.now() },
    })));
  },

  setErrorTo(sid, msg) {
    set(state => {
      const ses = state.sessions[sid] || emptySession();
      autoSave(sid, ses.entries);
      const errorCode = typeof msg === 'object' && msg ? msg.code : undefined;
      return updateSession(state, sid, s => ({
        ...s,
        error: msg,
        isStreaming: false,
        runStartedAt: null,
        runState: { ...s.runState, phase: msg ? 'error' : 'idle', currentTool: null, errorCode: (msg ? errorCode : null) as AgentErrorCode | null | undefined, lastEventAt: Date.now() },
      }));
    });
  },

  setRunStatusTo(sid, status) {
    set(state => updateSession(state, sid, ses => {
      const startedAt = status.startedAt !== undefined
        ? status.startedAt
        : ses.runState.startedAt || (status.phase === 'starting' ? Date.now() : null);
      const running = ['starting', 'requesting_model', 'thinking', 'streaming', 'tool_running', 'waiting_user', 'finishing'].includes(status.phase);
      return {
        ...ses,
        isStreaming: running,
        runStartedAt: running ? (ses.runStartedAt || startedAt || Date.now()) : null,
        error: status.phase === 'starting' ? null : ses.error,
        runState: {
          ...ses.runState,
          ...status,
          startedAt,
          lastEventAt: status.lastEventAt || Date.now(),
          inputTokens: status.inputTokens ?? ses.runState.inputTokens,
          outputTokens: status.outputTokens ?? ses.runState.outputTokens,
          phase: status.phase,
        },
      };
    }));
  },

  setRunTokensTo(sid, inputTokens, outputTokens) {
    set(state => updateSession(state, sid, ses => ({
      ...ses,
      runState: ses.runState.inputTokens === inputTokens && ses.runState.outputTokens === outputTokens
        ? ses.runState
        : { ...ses.runState, inputTokens, outputTokens, lastEventAt: Date.now() },
    })));
  },

  trimEntriesFrom(sid, fromIndex) {
    set(state => updateSession(state, sid, ses => {
      if (fromIndex < 0 || fromIndex >= ses.entries.length) return ses;
      return { ...ses, entries: ses.entries.slice(0, fromIndex) };
    }));
  },

  setSessionModelTo(sid, modelId) {
    set(state => updateSession(state, sid, ses => ({ ...ses, modelId })));
    if (get().activeId === sid) useAppStore.getState().setModel(modelId);
  },

  setEntryToolSummaryExpanded(sid, entryId, expanded) {
    set(state => updateSession(state, sid, ses => ({
      ...ses,
      entries: ses.entries.map(e =>
        e.id === entryId ? { ...e, toolSummaryExpanded: expanded } : e,
      ),
    })));
  },

  ensureActiveSession() {
    const existing = get().activeId;
    if (existing) {
      currentSessionId = existing;
      return existing;
    }

    const id = createSessionId();
    const modelId = useAppStore.getState().currentModel;
    currentSessionId = id;
    set(state => ({
      ...state,
      activeId: id,
      sessions: { ...state.sessions, [id]: emptySession(modelId) },
    }));
    return id;
  },

  startNew(modelId) {
    currentSessionId = null;
    if (modelId) useAppStore.getState().setModel(modelId);
    set(state => {
      const { default: _defaultSession, ...rest } = state.sessions;
      return { ...state, activeId: null, sessions: rest };
    });
  },

  switchTo(id) {
    currentSessionId = id;
    const modelId = get().sessions[id]?.modelId;
    if (modelId) useAppStore.getState().setModel(modelId);
    set(state => ({
      ...state,
      activeId: id,
      sessions: state.sessions[id] ? state.sessions : { ...state.sessions, [id]: emptySession(useAppStore.getState().currentModel) },
    }));
  },

  loadEntries(id, entries, modelId) {
    currentSessionId = id;
    titlesGenerated.add(id);
    if (modelId) useAppStore.getState().setModel(modelId);
    set(state => ({
      ...state,
      activeId: id,
      sessions: { ...state.sessions, [id]: { ...emptySession(modelId), entries } },
    }));
  },

  removeSession(id) {
    titlesGenerated.delete(id);
    if (currentSessionId === id) currentSessionId = null;
    set(state => {
      const { [id]: _removed, ...rest } = state.sessions;
      return {
        ...state,
        activeId: state.activeId === id ? null : state.activeId,
        sessions: rest,
      };
    });
  },

  clearActive() {
    currentSessionId = null;
    set(state => {
      const id = state.activeId || 'default';
      const { [id]: _, ...rest } = state.sessions;
      return { activeId: null, sessions: rest };
    });
  },
}));

const EMPTY: ChatEntry[] = [];

export function useActiveEntries(): ChatEntry[] {
  return useChatStore(s => {
    const id = s.activeId;
    if (!id) return EMPTY;
    const ses = s.sessions[id];
    return ses ? ses.entries : EMPTY;
  });
}

export function useActiveStreamingText(): string {
  return useChatStore(s => {
    const id = s.activeId;
    if (!id) return '';
    const ses = s.sessions[id];
    return ses ? ses.streamingText : '';
  });
}

export function useActiveIsStreaming(): boolean {
  return useChatStore(s => {
    const id = s.activeId;
    if (!id) return false;
    const ses = s.sessions[id];
    return ses ? ses.isStreaming : false;
  });
}

export function useActiveRunStartedAt(): number | null {
  return useChatStore(s => {
    const id = s.activeId;
    if (!id) return null;
    const ses = s.sessions[id];
    return ses ? ses.runStartedAt : null;
  });
}

export function useActiveError(): string | AgentError | null {
  return useChatStore(s => {
    const id = s.activeId;
    if (!id) return null;
    const ses = s.sessions[id];
    return ses ? ses.error : null;
  });
}

export function useActiveThinkingText(): string {
  return useChatStore(s => {
    const id = s.activeId;
    if (!id) return '';
    const ses = s.sessions[id];
    return ses ? ses.thinkingText : '';
  });
}

export function useActiveRunState(): RunState {
  return useChatStore(s => {
    const id = s.activeId;
    if (!id) return EMPTY_RUN_STATE;
    const ses = s.sessions[id];
    return ses ? ses.runState : EMPTY_RUN_STATE;
  });
}

export function useActivePendingContext(): string | null {
  return useChatStore(s => {
    const id = s.activeId;
    if (!id) return null;
    const ses = s.sessions[id];
    return ses ? ses.pendingContext : null;
  });
}

export function resetSessionId() {
  currentSessionId = null;
}

export function getSessionId(): string | null {
  return currentSessionId;
}

export function setSessionId(id: string) {
  currentSessionId = id;
  titlesGenerated.add(id);
}
