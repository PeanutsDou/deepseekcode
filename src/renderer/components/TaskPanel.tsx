import React, { useEffect, useState } from 'react';
import { useChatStore } from '../stores/chat-store';
import { EMPTY_COLLAB_TASKS, refreshCollabState, useCollabStore, type CollabTaskView } from '../stores/collab-store';
import { ArtifactPreviewButton } from './ArtifactPreview';

interface AgentTask {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  completedAt?: number;
}

function statusLabel(status: AgentTask['status']): string {
  if (status === 'in_progress') return '进行中';
  if (status === 'completed') return '完成';
  return '待办';
}

export function TaskPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const activeId = useChatStore(s => s.activeId);
  const collabTasks = useCollabStore(s => activeId ? s.tasks[activeId] || EMPTY_COLLAB_TASKS : EMPTY_COLLAB_TASKS);

  useEffect(() => {
    if (!open) return;
    window.electronAPI?.listTasks?.().then((items: any) => setTasks(Array.isArray(items) ? items : [])).catch(() => {});
    const unsub = window.electronAPI?.onTasksUpdated?.((items: any) => {
      setTasks(Array.isArray(items) ? items as AgentTask[] : []);
    });
    return () => unsub?.();
  }, [open]);

  useEffect(() => {
    if (!open || !activeId) return;
    void refreshCollabState(activeId);
  }, [open, activeId]);

  if (!open) return null;

  const active = tasks.filter(task => task.status !== 'completed');
  const completed = tasks.filter(task => task.status === 'completed');
  const refreshActiveCollab = () => {
    if (activeId) void refreshCollabState(activeId);
  };

  const abortCollab = async (taskId: string) => {
    await window.electronAPI?.abortCollabTask?.(taskId).catch(() => {});
    refreshActiveCollab();
  };

  const retryCollab = async (taskId: string, phase?: string) => {
    await window.electronAPI?.retryCollabTask?.(taskId, phase).catch(() => {});
    refreshActiveCollab();
  };

  const approveCollab = async (taskId: string) => {
    await window.electronAPI?.approveCollabTask?.(taskId).catch(() => {});
    refreshActiveCollab();
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog task-panel-dialog" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>任务面板</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>
        <div className="settings-body task-panel-body">
          {tasks.length === 0 && collabTasks.length === 0 && <div className="md-empty">当前没有 Agent 任务。</div>}

          {collabTasks.length > 0 && <div className="md-section-title">模型协同任务</div>}
          {collabTasks.map((task: CollabTaskView) => (
            <div className={`task-panel-item collab-task-panel-item collab-task-${task.status}`} key={task.id}>
              <div className="task-panel-row">
                <span className={`task-panel-status task-panel-status-${task.status === 'approved' ? 'completed' : task.status === 'failed' ? 'failed' : 'in_progress'}`}>
                  {task.status}
                </span>
                <strong>{task.userMessage.slice(0, 80) || task.id}</strong>
              </div>
              <div className="collab-task-phases">
                {task.agents.map(agent => (
                  <span key={`${task.id}-${agent.role}`} className={`collab-task-phase collab-task-phase-${agent.status}`}>
                    {agent.label}: {agent.phase}
                  </span>
                ))}
              </div>
              {task.lastEvent?.message && <div className="task-panel-desc">{task.lastEvent.message}</div>}
              {task.artifacts.length > 0 && (
                <div className="task-panel-artifacts">
                  {task.artifacts.map(artifact => (
                    <ArtifactPreviewButton key={artifact.id} taskId={task.id} artifact={artifact} />
                  ))}
                </div>
              )}
              <div className="task-panel-actions">
                {!['approved', 'failed', 'cancelled'].includes(task.status) && (
                  <button type="button" className="settings-btn-sm" onClick={() => abortCollab(task.id)}>终止</button>
                )}
                {task.status === 'needs_fix' && (
                  <>
                    <button type="button" className="settings-btn-sm" onClick={() => retryCollab(task.id, task.currentPhase)}>继续修复</button>
                    <button type="button" className="settings-btn-sm" onClick={() => approveCollab(task.id)}>人工通过</button>
                  </>
                )}
              </div>
            </div>
          ))}

          {active.length > 0 && <div className="md-section-title">当前任务</div>}
          {active.map(task => (
            <div className="task-panel-item" key={task.id}>
              <div className="task-panel-row">
                <span className={`task-panel-status task-panel-status-${task.status}`}>{statusLabel(task.status)}</span>
                <strong>{task.subject}</strong>
              </div>
              {task.description && <div className="task-panel-desc">{task.description}</div>}
              {task.blockedBy.length > 0 && <div className="task-panel-meta">阻塞于：{task.blockedBy.map(id => id.slice(0, 8)).join(', ')}</div>}
            </div>
          ))}

          {completed.length > 0 && <div className="md-section-title">已完成</div>}
          {completed.map(task => (
            <div className="task-panel-item completed" key={task.id}>
              <div className="task-panel-row">
                <span className={`task-panel-status task-panel-status-${task.status}`}>{statusLabel(task.status)}</span>
                <strong>{task.subject}</strong>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
