import { create } from 'zustand';
import type { CollabCliCheckResult, CollabConfig, CollabEvent } from '../../shared/types';

export interface CollabAgentStatusView {
  role: 'neck' | 'codex' | 'claude';
  label: string;
  model?: string;
  phase: string;
  status: string;
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
  status: string;
  currentPhase: string;
  createdAt: number;
  updatedAt: number;
  agents: CollabAgentStatusView[];
  artifacts: Array<{ id: string; type: string; path: string; createdAt: number }>;
  lastEvent?: CollabEvent;
}

export interface CollabSessionStatusView {
  enabled: boolean;
  sessionId: string;
  collabSessionId?: string;
  workspaceRoot: string;
  status?: string;
  activeTask?: CollabTaskView | null;
  locked: boolean;
}

export const EMPTY_COLLAB_TASKS: CollabTaskView[] = [];

interface CollabState {
  config: CollabConfig | null;
  cliCheck: CollabCliCheckResult | null;
  checking: boolean;
  sessionStatus: Record<string, CollabSessionStatusView>;
  tasks: Record<string, CollabTaskView[]>;
  lastEvents: Record<string, CollabEvent>;
  setConfig: (config: CollabConfig | null) => void;
  setCliCheck: (result: CollabCliCheckResult | null) => void;
  setChecking: (checking: boolean) => void;
  setSessionStatus: (sessionId: string, status: CollabSessionStatusView) => void;
  setTasks: (sessionId: string, tasks: CollabTaskView[]) => void;
  recordEvent: (event: CollabEvent) => void;
}

export const useCollabStore = create<CollabState>((set) => ({
  config: null,
  cliCheck: null,
  checking: false,
  sessionStatus: {},
  tasks: {},
  lastEvents: {},
  setConfig: (config) => set(state => {
    const commandChanged = Boolean(config && state.config && (
      config.codexCommand !== state.config.codexCommand
      || config.claudeCommand !== state.config.claudeCommand
    ));
    return {
      config,
      ...(commandChanged ? { cliCheck: null } : {}),
    };
  }),
  setCliCheck: (cliCheck) => set({ cliCheck }),
  setChecking: (checking) => set({ checking }),
  setSessionStatus: (sessionId, status) => set(state => ({
    sessionStatus: { ...state.sessionStatus, [sessionId]: status },
  })),
  setTasks: (sessionId, tasks) => set(state => ({
    tasks: { ...state.tasks, [sessionId]: tasks },
  })),
  recordEvent: (event) => set(state => {
    const sessionId = event.sessionId;
    const existing = state.tasks[sessionId] || [];
    const tasks = existing.map(task => task.id === event.taskId
      ? { ...task, status: String(event.status || task.status), currentPhase: event.phase || task.currentPhase, lastEvent: event, updatedAt: event.createdAt }
      : task);
    return {
      lastEvents: { ...state.lastEvents, [sessionId]: event },
      tasks: { ...state.tasks, [sessionId]: tasks },
    };
  }),
}));

export async function refreshCollabState(sessionId?: string): Promise<void> {
  const api = window.electronAPI;
  if (!api) return;
  try {
    const config = await api.getCollabConfig();
    useCollabStore.getState().setConfig(config);
  } catch {}
  if (sessionId) {
    try {
      const status = await api.getCollabSessionStatus(sessionId) as CollabSessionStatusView;
      useCollabStore.getState().setSessionStatus(sessionId, status);
    } catch {}
    try {
      const tasks = await api.listCollabTasks(sessionId) as CollabTaskView[];
      useCollabStore.getState().setTasks(sessionId, tasks);
    } catch {}
  }
}
