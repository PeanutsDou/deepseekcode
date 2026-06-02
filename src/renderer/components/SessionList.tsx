import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getSessionStatus, setSessionId, useChatStore, type ChatEntry, type SessionStatus } from '../stores/chat-store';
import { useAppStore } from '../stores/app-store';

interface SessionItem {
  id: string;
  title?: string;
  modelId?: string;
  createdAt?: number;
  updatedAt?: number;
  pinnedAt?: number | null;
  groupId?: string | null;
}

interface SessionGroupItem {
  id: string;
  name: string;
  createdAt?: number;
  updatedAt?: number;
  pinnedAt?: number | null;
  collapsed?: boolean;
}

type DisplaySession = SessionItem & { status: SessionStatus };

const statusLabels: Record<SessionStatus, string> = {
  idle: '无任务',
  running: '进行中',
  error: '错误',
};

function isPinned(session: SessionItem): boolean {
  return typeof session.pinnedAt === 'number' && session.pinnedAt > 0;
}

function compareSessions(a: SessionItem, b: SessionItem): number {
  const aPinned = isPinned(a);
  const bPinned = isPinned(b);
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  const updatedCompare = (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
  if (updatedCompare !== 0) return updatedCompare;
  const pinnedCompare = (b.pinnedAt || 0) - (a.pinnedAt || 0);
  if (pinnedCompare !== 0) return pinnedCompare;
  return a.id.localeCompare(b.id);
}

function isChatRole(value: unknown): value is ChatEntry['role'] {
  return value === 'user' || value === 'assistant' || value === 'tool' || value === 'system';
}

function optionalText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeToolSummary(value: unknown): ChatEntry['toolSummary'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: NonNullable<ChatEntry['toolSummary']> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const name = optionalText(raw.name);
    if (!name) continue;
    tools.push({
      name,
      argumentsText: optionalText(raw.argumentsText) || '',
      resultPreview: optionalText(raw.resultPreview) || '',
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function normalizeChatEntry(message: unknown, index: number): ChatEntry {
  const raw = message && typeof message === 'object' ? message as Record<string, unknown> : {};
  const timestamp = typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
    ? raw.timestamp
    : typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : Date.now();

  return {
    ...(raw as Partial<ChatEntry>),
    id: typeof raw.id === 'string' && raw.id ? raw.id : `entry_${timestamp}_${index}_${Math.random().toString(36).slice(2, 8)}`,
    role: isChatRole(raw.role) ? raw.role : 'assistant',
    content: optionalText(raw.content) || '',
    attachments: Array.isArray(raw.attachments) ? raw.attachments as ChatEntry['attachments'] : undefined,
    toolName: optionalText(raw.toolName),
    toolArgs: optionalText(raw.toolArgs),
    toolResult: optionalText(raw.toolResult),
    toolCallId: optionalText(raw.toolCallId),
    toolSummary: normalizeToolSummary(raw.toolSummary),
    toolSummaryExpanded: typeof raw.toolSummaryExpanded === 'boolean' ? raw.toolSummaryExpanded : undefined,
    collabEvent: raw.collabEvent && typeof raw.collabEvent === 'object' ? raw.collabEvent as ChatEntry['collabEvent'] : undefined,
    timestamp,
  };
}

export function SessionList() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [groups, setGroups] = useState<SessionGroupItem[]>([]);
  const [loading, setLoading] = useState(false);
  const { loadEntries, removeSession, startNew, switchTo } = useChatStore();
  const toggleSessions = useAppStore(s => s.toggleSessions);
  const activeId = useChatStore(s => s.activeId);
  const localSessions = useChatStore(s => s.sessions);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [groupCtxMenu, setGroupCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [blankCtxMenu, setBlankCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [groupRenameValue, setGroupRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const groupRenameRef = useRef<HTMLInputElement>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.electronAPI.listSessions();
      setSessions(list as SessionItem[]);
      const groupList = await window.electronAPI?.listSessionGroups?.();
      setGroups((groupList || []) as SessionGroupItem[]);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSessions();
    const handler = () => loadSessions();
    window.addEventListener('session-saved', handler);
    const unsubscribe = window.electronAPI?.onSessionSaved?.(handler);
    return () => {
      window.removeEventListener('session-saved', handler);
      unsubscribe?.();
    };
  }, [loadSessions]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [ctxMenu]);

  useEffect(() => {
    if (!groupCtxMenu && !blankCtxMenu) return;
    const close = () => {
      setGroupCtxMenu(null);
      setBlankCtxMenu(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [groupCtxMenu, blankCtxMenu]);

  useEffect(() => {
    if (renaming) renameRef.current?.focus();
  }, [renaming]);

  useEffect(() => {
    if (renamingGroup) groupRenameRef.current?.focus();
  }, [renamingGroup]);

  const handleNew = async () => {
    try {
      const cfg = await window.electronAPI?.getConfig();
      startNew(cfg?.model);
    } catch {
      startNew();
    }
  };

  const handleLoad = async (id: string) => {
    if (renaming) return;
    if (localSessions[id]) {
      setSessionId(id);
      switchTo(id);
      return;
    }

    try {
      const session = await window.electronAPI.loadSession(id);
      if (!session) return;

      const s = session as { id: string; modelId?: string; messages?: Array<ChatEntry>; agentMessages?: unknown[] };
      setSessionId(s.id);
      const chatEntries = (s.messages || []).map(normalizeChatEntry);
      const modelId = s.modelId || useAppStore.getState().currentModel;
      loadEntries(s.id, chatEntries, modelId);

      const agentMessages = Array.isArray(s.agentMessages) && s.agentMessages.length > 0
        ? s.agentMessages
        : (s.messages || [])
          .filter(msg => msg.role === 'user' || msg.role === 'assistant')
          .map(msg => ({ role: msg.role, content: msg.content, attachments: msg.attachments }));
      window.electronAPI?.setAgentContext?.(s.id, agentMessages, modelId);
    } catch (err) {
      console.error('Failed to load session:', err);
    }
  };

  const handleDelete = async (id: string) => {
    setCtxMenu(null);
    removeSession(id);
    try {
      await window.electronAPI.abort(id);
      await window.electronAPI.resetAgent(id);
      await window.electronAPI.deleteSession(id);
      loadSessions();
    } catch {
      loadSessions();
    }
  };

  const handleContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, id });
    setGroupCtxMenu(null);
    setBlankCtxMenu(null);
  };

  const handleBlankContextMenu = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    setBlankCtxMenu({ x: e.clientX, y: e.clientY });
    setCtxMenu(null);
    setGroupCtxMenu(null);
  };

  const handleGroupContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setGroupCtxMenu({ x: e.clientX, y: e.clientY, id });
    setCtxMenu(null);
    setBlankCtxMenu(null);
  };

  const startRename = () => {
    if (!ctxMenu) return;
    const s = sessions.find(x => x.id === ctxMenu.id);
    setRenaming(ctxMenu.id);
    setRenameValue(s?.title || '');
    setCtxMenu(null);
  };

  const togglePinned = async () => {
    if (!ctxMenu) return;
    const id = ctxMenu.id;
    const s = sessions.find(x => x.id === id);
    setCtxMenu(null);
    try {
      await window.electronAPI?.setSessionPinned?.(id, !isPinned(s || { id }));
      loadSessions();
    } catch {
      loadSessions();
    }
  };

  const createGroup = async () => {
    setBlankCtxMenu(null);
    const group = await window.electronAPI?.createSessionGroup?.('新建组');
    await loadSessions();
    if (group?.id) {
      setRenamingGroup(group.id);
      setGroupRenameValue(group.name || '新建组');
    }
  };

  const startGroupRename = () => {
    if (!groupCtxMenu) return;
    const group = groups.find(g => g.id === groupCtxMenu.id);
    setRenamingGroup(groupCtxMenu.id);
    setGroupRenameValue(group?.name || '');
    setGroupCtxMenu(null);
  };

  const commitGroupRename = async () => {
    const newName = groupRenameValue.trim();
    if (newName && renamingGroup) {
      await window.electronAPI?.renameSessionGroup?.(renamingGroup, newName);
      loadSessions();
    }
    setRenamingGroup(null);
    setGroupRenameValue('');
  };

  const handleGroupRenameKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitGroupRename();
    if (e.key === 'Escape') {
      setRenamingGroup(null);
      setGroupRenameValue('');
    }
  };

  const toggleGroupPinned = async () => {
    if (!groupCtxMenu) return;
    const group = groups.find(g => g.id === groupCtxMenu.id);
    if (!group) return;
    setGroupCtxMenu(null);
    await window.electronAPI?.setSessionGroupPinned?.(group.id, !(group.pinnedAt && group.pinnedAt > 0));
    loadSessions();
  };

  const toggleGroupCollapsed = async (group: SessionGroupItem) => {
    await window.electronAPI?.setSessionGroupCollapsed?.(group.id, !group.collapsed);
    loadSessions();
  };

  const deleteGroup = async () => {
    if (!groupCtxMenu) return;
    const group = groups.find(g => g.id === groupCtxMenu.id);
    setGroupCtxMenu(null);
    if (!window.confirm(`删除分组「${group?.name || '未命名'}」？组内会话会移回未分组。`)) return;
    if (group) await window.electronAPI?.deleteSessionGroup?.(group.id);
    loadSessions();
  };

  const assignSessionToGroup = async (sessionId: string, groupId: string | null) => {
    await window.electronAPI?.assignSessionGroup?.(sessionId, groupId);
    loadSessions();
  };

  const handleSessionDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/session-id', id);
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleGroupDrop = (e: React.DragEvent, groupId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const sessionId = e.dataTransfer.getData('text/session-id') || e.dataTransfer.getData('text/plain');
    if (sessionId) void assignSessionToGroup(sessionId, groupId);
  };

  const handleGroupDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const commitRename = async () => {
    const newTitle = renameValue.trim();
    if (newTitle && renaming) {
      await window.electronAPI?.renameSession(renaming, newTitle);
      loadSessions();
    }
    setRenaming(null);
    setRenameValue('');
  };

  const handleRenameKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') {
      setRenaming(null);
      setRenameValue('');
    }
  };

  const displayedSessions: DisplaySession[] = sessions.map(s => ({
    ...s,
    status: getSessionStatus(localSessions[s.id]),
  }));
  const persistedIds = new Set(sessions.map(s => s.id));
  for (const [id, local] of Object.entries(localSessions)) {
    if (id === 'default' || persistedIds.has(id)) continue;
    if (local.entries.length === 0 && !local.isStreaming && !local.error) continue;
    const firstUser = local.entries.find(entry => entry.role === 'user')?.content;
    const firstTimestamp = local.entries[0]?.timestamp;
    const lastTimestamp = local.entries[local.entries.length - 1]?.timestamp;
    displayedSessions.push({
      id,
      title: firstUser ? firstUser.slice(0, 50) : 'Untitled',
      modelId: local.modelId || 'unknown',
      createdAt: firstTimestamp || lastTimestamp || Date.now(),
      updatedAt: lastTimestamp || Date.now(),
      pinnedAt: null,
      status: getSessionStatus(local),
    });
  }
  displayedSessions.sort(compareSessions);
  const ctxMenuSession = ctxMenu ? displayedSessions.find(s => s.id === ctxMenu.id) : null;
  const sessionsByGroup = new Map<string, DisplaySession[]>();
  const ungroupedSessions: DisplaySession[] = [];
  for (const session of displayedSessions) {
    if (session.groupId) {
      const list = sessionsByGroup.get(session.groupId) || [];
      list.push(session);
      sessionsByGroup.set(session.groupId, list);
    } else {
      ungroupedSessions.push(session);
    }
  }
  for (const list of sessionsByGroup.values()) list.sort(compareSessions);
  ungroupedSessions.sort(compareSessions);
  const visibleGroups = groups
    .map(group => {
      const items = sessionsByGroup.get(group.id) || [];
      const lastActivity = items.reduce((max, item) => Math.max(max, item.updatedAt || item.createdAt || 0), group.updatedAt || group.createdAt || 0);
      const hasPinnedSession = items.some(isPinned);
      return { group, items, lastActivity, hasPinnedSession };
    })
    .filter(section => section.items.length > 0 || !section.group.name.startsWith('__hidden__'))
    .sort((a, b) => {
      const aPinned = Boolean(a.group.pinnedAt && a.group.pinnedAt > 0);
      const bPinned = Boolean(b.group.pinnedAt && b.group.pinnedAt > 0);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (a.hasPinnedSession !== b.hasPinnedSession) return a.hasPinnedSession ? -1 : 1;
      const activityCompare = b.lastActivity - a.lastActivity;
      if (activityCompare !== 0) return activityCompare;
      return a.group.name.localeCompare(b.group.name);
    });
  const groupCtx = groupCtxMenu ? groups.find(g => g.id === groupCtxMenu.id) : null;
  const displayRows = [
    ...visibleGroups.map(section => ({
      kind: 'group' as const,
      id: section.group.id,
      pinned: Boolean(section.group.pinnedAt && section.group.pinnedAt > 0),
      activity: section.lastActivity,
      section,
    })),
    ...ungroupedSessions.map(session => ({
      kind: 'session' as const,
      id: session.id,
      pinned: isPinned(session),
      activity: session.updatedAt || session.createdAt || 0,
      session,
    })),
  ].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const activityCompare = b.activity - a.activity;
    if (activityCompare !== 0) return activityCompare;
    return a.id.localeCompare(b.id);
  });

  const renderSession = (s: DisplaySession) => {
    const pinned = isPinned(s);
    return (
      <div
        key={s.id}
        className={`session-item ${activeId === s.id ? 'active' : ''} ${pinned ? 'pinned' : ''}`}
        draggable
        onDragStart={e => handleSessionDragStart(e, s.id)}
        onClick={() => handleLoad(s.id)}
        onContextMenu={e => handleContextMenu(e, s.id)}
      >
        {renaming === s.id ? (
          <input
            ref={renameRef}
            className="session-rename-input"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleRenameKey}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <div className="session-item-title-row">
            <div className="session-item-title">{s.title || 'Untitled'}</div>
            {pinned && <span className="session-pin-badge">置顶</span>}
          </div>
        )}
        <div className="session-item-meta">
          <span className="session-item-model">{s.modelId || 'unknown'}</span>
          <span className="session-item-time">
            {s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : ''}
          </span>
          <span className={`session-status session-status-${s.status}`}>
            <span className="session-status-dot" />
            {statusLabels[s.status]}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="session-list">
      <div className="session-list-header">
        <span className="session-list-title">Sessions</span>
        <div className="session-list-actions">
          <button className="session-btn" onClick={toggleSessions} title="收起会话列表">‹</button>
          <button className="session-btn" onClick={handleNew} title="新建会话">+</button>
        </div>
      </div>
      <div
        className="session-list-items"
        onContextMenu={handleBlankContextMenu}
        onDragOver={handleGroupDragOver}
        onDrop={e => handleGroupDrop(e, null)}
      >
        {loading && <div className="session-list-loading">Loading...</div>}
        {displayedSessions.length === 0 && !loading && (
          <div className="session-list-empty">Send a message to auto-save</div>
        )}
        {displayRows.map(row => {
          if (row.kind === 'session') return renderSession(row.session);
          const { group, items } = row.section;
          return (
            <div
              key={group.id}
              className={`session-group ${group.pinnedAt ? 'pinned' : ''}`}
              onDragOver={handleGroupDragOver}
              onDrop={e => handleGroupDrop(e, group.id)}
            >
              <div className="session-group-header" onContextMenu={e => handleGroupContextMenu(e, group.id)}>
                <button className="session-group-toggle" onClick={() => toggleGroupCollapsed(group)}>
                  {group.collapsed ? '›' : '⌄'}
                </button>
                {renamingGroup === group.id ? (
                  <input
                    ref={groupRenameRef}
                    className="session-rename-input session-group-rename"
                    value={groupRenameValue}
                    onChange={e => setGroupRenameValue(e.target.value)}
                    onBlur={commitGroupRename}
                    onKeyDown={handleGroupRenameKey}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span className="session-group-name">{group.name}</span>
                )}
                {group.pinnedAt && <span className="session-pin-badge">置顶</span>}
                <span className="session-group-count">{items.length}</span>
              </div>
              {!group.collapsed && (
                items.length > 0
                  ? items.map(renderSession)
                  : <div className="session-group-drop-hint">拖入会话</div>
              )}
            </div>
          );
        })}
      </div>

      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button className="ctx-menu-item" onClick={togglePinned}>
            {ctxMenuSession && isPinned(ctxMenuSession) ? '取消置顶' : '置顶'}
          </button>
          <button className="ctx-menu-item" onClick={startRename}>
            重命名
          </button>
          {ctxMenuSession?.groupId && (
            <button className="ctx-menu-item" onClick={() => { const id = ctxMenu.id; setCtxMenu(null); assignSessionToGroup(id, null); }}>
              移出分组
            </button>
          )}
          <button className="ctx-menu-item ctx-menu-danger" onClick={() => handleDelete(ctxMenu.id)}>
            删除
          </button>
        </div>
      )}
      {groupCtxMenu && (
        <div className="ctx-menu" style={{ left: groupCtxMenu.x, top: groupCtxMenu.y }}>
          <button className="ctx-menu-item" onClick={toggleGroupPinned}>
            {groupCtx?.pinnedAt ? '取消组置顶' : '组置顶'}
          </button>
          <button className="ctx-menu-item" onClick={startGroupRename}>
            重命名组
          </button>
          {groupCtx && (
            <button className="ctx-menu-item" onClick={() => { setGroupCtxMenu(null); toggleGroupCollapsed(groupCtx); }}>
              {groupCtx.collapsed ? '展开组' : '收起组'}
            </button>
          )}
          <button className="ctx-menu-item ctx-menu-danger" onClick={deleteGroup}>
            删除组
          </button>
        </div>
      )}
      {blankCtxMenu && (
        <div className="ctx-menu" style={{ left: blankCtxMenu.x, top: blankCtxMenu.y }}>
          <button className="ctx-menu-item" onClick={createGroup}>
            新建组
          </button>
        </div>
      )}
    </div>
  );
}
