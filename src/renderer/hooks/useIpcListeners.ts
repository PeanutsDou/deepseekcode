import { useEffect } from 'react';
import { useChatStore } from '../stores/chat-store';
import { inferImageMimeType } from '../utils/attachments';
import { refreshCollabState, useCollabStore } from '../stores/collab-store';

export function useIpcListeners() {
  const store = useChatStore;

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const unsubs: Array<() => void> = [];

    unsubs.push(api.onDelta((sid, text) => {
      store.getState().appendDeltaTo(sid, text);
    }));
    unsubs.push(api.onThinkingDelta((sid, text) => {
      store.getState().appendThinkingDeltaTo(sid, text);
    }));
    unsubs.push(api.onRunStatus((sid, status: any) => {
      store.getState().setRunStatusTo(sid, status);
    }));
    unsubs.push(api.onQueuedCount((sid, count: number) => {
      window.dispatchEvent(new CustomEvent('agent-queued-count', { detail: { sid, count } }));
    }));
    unsubs.push(api.onQueuedMessageStart((sid, data: any) => {
      const attachments = Array.isArray(data.attachments)
        ? data.attachments.map((att: any, i: number) => ({
          type: att.type || 'image',
          data: att.data,
          mimeType: att.mimeType || inferImageMimeType(att.data || ''),
          name: att.name || `queued-${i + 1}.png`,
          size: att.size || 0,
        }))
        : undefined;
      store.getState().addEntryTo(sid, {
        id: data.id || `queued_${Date.now()}`,
        role: 'user',
        content: data.content || '',
        attachments,
        timestamp: Date.now(),
      });
    }));
    unsubs.push(api.onToolStart((sid, data: any) => {
      store.getState().addEntryTo(sid, {
        id: data.id || `tool_${Date.now()}`,
        role: 'tool',
        content: '',
        toolCallId: data.id,
        toolName: data.name,
        toolArgs: data.argumentsText,
        timestamp: Date.now(),
      });
    }));
    unsubs.push(api.onToolResult((sid, data: any) => {
      store.getState().updateEntriesTo(sid, currentEntries => {
        const entries = [...currentEntries];
        for (let i = entries.length - 1; i >= 0; i--) {
          const idMatches = data.toolCallId && entries[i].toolCallId === data.toolCallId;
          const fallbackMatches = !data.toolCallId && entries[i].toolName === data.name && !entries[i].toolResult;
          if (entries[i].role === 'tool' && (idMatches || fallbackMatches)) {
            entries[i] = { ...entries[i], content: data.result, toolResult: data.result };
            return entries;
          }
        }
        return currentEntries;
      });
    }));
    unsubs.push(api.onToolSummary?.((sid, data: any) => {
      if (!data?.summary) return;
      store.getState().addEntryTo(sid, {
        id: `tool_summary_${Date.now()}`,
        role: 'system',
        content: data.summary || '',
        toolSummary: Array.isArray(data.tools) ? data.tools : undefined,
        timestamp: Date.now(),
      });
    }) || (() => {}));
    unsubs.push(api.onTurnDone((sid, data: any) => {
      store.getState().finishStreamTo(sid, data.text);
    }));
    unsubs.push(api.onError((sid, err) => {
      store.getState().setErrorTo(sid, err as any);
    }));
    unsubs.push(api.onCollabEvent?.((event: any) => {
      useCollabStore.getState().recordEvent(event);
      const collabEntry = (kind: string, content: string) => {
        if (!event?.sessionId || !content) return;
        store.getState().addEntryTo(event.sessionId, {
          id: `collab_${kind}_${event.id || Date.now()}`,
          role: 'system',
          content,
          collabEvent: event,
          timestamp: event.createdAt || Date.now(),
        });
      };
      if (event?.type === 'task_created') {
        collabEntry('task', `协同任务已创建：${String(event.taskId || '').slice(0, 8)}`);
        if (event?.sessionId) void refreshCollabState(event.sessionId);
        return;
      }
      if (event?.type === 'artifact_written') {
        if (['brief', 'result', 'diff', 'test_output', 'review'].includes(String(event.artifactType || ''))) {
          collabEntry('artifact', event.message || '协同产物已生成');
        }
        if (event?.sessionId) void refreshCollabState(event.sessionId);
        return;
      }
      if (['cli_tool', 'tool_started'].includes(event?.type) && event?.sessionId) {
        store.getState().addEntryTo(event.sessionId, {
          id: `collab_tool_${event.id || Date.now()}`,
          role: 'tool',
          content: event.message || '',
          toolName: 'collab_tool',
          toolArgs: JSON.stringify({
            agent: event.agentRole === 'claude' ? 'Claude Code' : event.agentRole === 'codex' ? 'Codex' : 'Neck',
            action: event.payload?.summary || event.message || '',
          }),
          toolResult: event.message || '',
          collabEvent: event,
          timestamp: event.createdAt || Date.now(),
        });
        if (event?.sessionId) void refreshCollabState(event.sessionId);
        return;
      }
      if (['output', 'cli_output', 'retry_started', 'review_needs_fix', 'task_failed', 'task_cancelled', 'task_completed', 'recovered_interrupted_task'].includes(event?.type) && event?.message) {
        collabEntry('event', event.message);
        if (event?.sessionId) void refreshCollabState(event.sessionId);
        return;
      }
      if (event?.sessionId) void refreshCollabState(event.sessionId);
    }) || (() => {}));
    unsubs.push(api.onCollabConfigUpdated?.((config: any) => {
      useCollabStore.getState().setConfig(config);
    }) || (() => {}));

    return () => { unsubs.forEach(fn => fn()); };
  }, []);
}
