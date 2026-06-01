import React, { useEffect } from 'react';
import { useChatStore } from '../stores/chat-store';
import { EMPTY_COLLAB_TASKS, refreshCollabState, useCollabStore } from '../stores/collab-store';

const ROLE_ORDER = ['neck', 'codex', 'claude'] as const;

const DEFAULT_AGENTS = [
  { role: 'neck', label: 'Neck Coordinator', phase: 'idle', status: 'idle' },
  { role: 'codex', label: 'Codex Worker', phase: 'idle', status: 'idle' },
  { role: 'claude', label: 'Claude Code Worker', phase: 'idle', status: 'idle' },
];

export function CollabAgentStrip() {
  const activeId = useChatStore(s => s.activeId);
  const config = useCollabStore(s => s.config);
  const status = useCollabStore(s => activeId ? s.sessionStatus[activeId] : undefined);
  const tasks = useCollabStore(s => activeId ? s.tasks[activeId] || EMPTY_COLLAB_TASKS : EMPTY_COLLAB_TASKS);

  useEffect(() => {
    void refreshCollabState(activeId || undefined);
  }, [activeId]);

  const activeTask = status?.activeTask || tasks[0] || null;
  const agents = activeTask?.agents?.length
    ? ROLE_ORDER.map(role => activeTask.agents.find(agent => agent.role === role)).filter(Boolean)
    : DEFAULT_AGENTS;
  const activeAgent = agents.find((agent: any) => agent.status === 'running') || null;
  const modeLabel = config?.enabled ? '模型协同' : '普通模式';
  const showPipeline = Boolean(config?.enabled || activeTask);

  return (
    <div className={`collab-agent-strip ${config?.enabled ? 'enabled' : 'disabled'}`}>
      <div className="collab-agent-strip-main">
        <span className="collab-mode-dot" />
        <strong>{modeLabel}</strong>
      </div>
      {showPipeline && (
        <div className="collab-agent-list">
          {agents.map((agent: any) => (
            <div
              className={`collab-agent-chip collab-agent-${agent.role} collab-agent-status-${agent.status} ${activeAgent && agent.role === activeAgent.role ? 'active' : ''}`}
              key={agent.role}
            >
              <strong>{agent.label}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
