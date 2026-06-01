import React, { Component, useState, useEffect } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { FileTree } from './components/FileTree';
import { EditorTabs } from './components/EditorTabs';
import { EditorPanel } from './components/EditorPanel';
import { SessionList } from './components/SessionList';
import { SettingsDialog } from './components/SettingsDialog';
import { ContextBar } from './components/ContextBar';
import { AskDialog } from './components/AskDialog';
import { SkillsDialog } from './components/SkillsDialog';
import { MemoryDialog } from './components/MemoryDialog';
import { AgentDialog } from './components/AgentDialog';
import { WorkspaceBar } from './components/WorkspaceBar';
import { ImageViewer } from './components/ImageViewer';
import { CloseDialog } from './components/CloseDialog';
import { ImShell } from './components/im/ImShell';
import { ResizeHandle } from './components/ResizeHandle';
import { UpdateBanner } from './components/UpdateBanner';
import { useAppStore } from './stores/app-store';
import { useImStore } from './stores/im-store';
import { useImEvents } from './hooks/useImEvents';
import { LIGHT_SCHEMES, normalizeLightScheme, type LightSchemeId } from './theme-schemes';

class ErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#b87070', fontFamily: 'monospace' }}>
          <h2>App Error</h2>
          <pre>{this.state.error.message}</pre>
          <pre>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

function handleMinimize() {
  window.electronAPI?.minimize?.();
}

function handleMaximize() {
  if (window.electronAPI?.maximize) {
    window.electronAPI.maximize();
  }
}

function handleClose() {
  window.electronAPI?.close?.();
}

export default function App() {
  const { showSidebar, toggleSidebar, showSessions, toggleSessions, leftWidth, setLeftWidth, theme, setTheme, lightScheme, setLightScheme } = useAppStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [codeLeftWidth, setCodeLeftWidth] = useState(() => 280);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const handleCodeResize = (delta: number) => {
    setCodeLeftWidth(prev => {
      const next = Math.max(180, Math.min(window.innerWidth * 0.5, prev + delta));
      window.electronAPI?.setConfig('codeLeftWidth', next);
      return next;
    });
  };
  const [mainMode, setMainMode] = useState<'agent' | 'im'>('agent');
  const imConversations = useImStore(s => s.conversations);
  const imFriends = useImStore(s => s.friends);
  const [imNotice, setImNotice] = useState<{ peerId: string; count: number } | null>(null);
  const unreadBaselineRef = React.useRef<Record<string, number>>({});
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const appearanceRef = React.useRef<HTMLDivElement>(null);
  useImEvents();

  // Double-click entire toolbar area to maximize
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const handler = () => {
      if (window.electronAPI?.maximize) window.electronAPI.maximize();
    };
    el.addEventListener('dblclick', handler);
    return () => el.removeEventListener('dblclick', handler);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-light-scheme', lightScheme);
  }, [theme, lightScheme]);

  useEffect(() => {
    if (!appearanceOpen) return;
    const close = (event: MouseEvent) => {
      if (!appearanceRef.current?.contains(event.target as Node)) {
        setAppearanceOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [appearanceOpen]);

  // Font scale via CSS variable
  const fontScale = useAppStore(s => s.fontScale);
  const setFontScale = useAppStore(s => s.setFontScale);
  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', `${fontScale / 100}`);
  }, [fontScale]);

  useEffect(() => {
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener('open-settings', openSettings);
    return () => window.removeEventListener('open-settings', openSettings);
  }, []);

  // Load config-driven state
  useEffect(() => {
    const loadConfig = () => {
      window.electronAPI?.getConfig().then((c: any) => {
        useAppStore.getState().setTheme(c.theme || 'light');
        useAppStore.getState().setLightScheme(normalizeLightScheme(c.lightScheme));
        useAppStore.getState().setFontScale(c.fontScale || 100);
        useAppStore.getState().setModel(c.model);
        if (c.version) {
          setVersion(c.version);
          if (c.lastSeenReleaseNotesVersion !== c.version) setReleaseNotesOpen(true);
        }
        useAppStore.getState().setAvailableModels(c.models || []);
        if (c.codeLeftWidth) setCodeLeftWidth(c.codeLeftWidth);
      }).catch(() => {});
      window.electronAPI?.getAlwaysOnTop?.().then((v: boolean) => setAlwaysOnTop(Boolean(v))).catch(() => {});
    };
    loadConfig();
    const handler = () => loadConfig();
    window.addEventListener('providers-changed', handler);
    window.addEventListener('open-image-viewer', ((e: CustomEvent) => setViewerSrc(e.detail)) as EventListener);
    return () => window.removeEventListener('providers-changed', handler);
  }, []);

  // Ctrl+Scroll to zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -5 : 5;
        const newScale = useAppStore.getState().fontScale + delta;
        useAppStore.getState().setFontScale(newScale);
        window.electronAPI?.setConfig('fontScale', newScale).catch(() => {});
      }
    };
    document.addEventListener('wheel', handler, { passive: false });
    return () => document.removeEventListener('wheel', handler);
  }, []);

  const applyLightScheme = (scheme: LightSchemeId) => {
    setLightScheme(scheme);
    window.electronAPI?.setConfig('lightScheme', scheme).catch(() => {});
    setAppearanceOpen(false);
  };

  useEffect(() => {
    const currentCounts = Object.fromEntries(imConversations.map(c => [c.peerUserId, c.unreadCount || 0]));
    if (mainMode === 'im') {
      unreadBaselineRef.current = currentCounts;
      setImNotice(null);
      return;
    }

    let latestIncrease: { peerId: string; count: number; at: number } | null = null;
    for (const conversation of imConversations) {
      const current = conversation.unreadCount || 0;
      const baseline = unreadBaselineRef.current[conversation.peerUserId] || 0;
      if (current > baseline) {
        const count = current - baseline;
        if (!latestIncrease || (conversation.lastMessageAt || 0) > latestIncrease.at) {
          latestIncrease = { peerId: conversation.peerUserId, count, at: conversation.lastMessageAt || 0 };
        }
      }
    }

    if (latestIncrease) setImNotice({ peerId: latestIncrease.peerId, count: latestIncrease.count });
    unreadBaselineRef.current = currentCounts;
  }, [imConversations, mainMode]);

  const noticeConversation = imNotice
    ? imConversations.find(c => c.peerUserId === imNotice.peerId)
    : undefined;
  const noticeFriend = imNotice
    ? imFriends.find(f => f.userId === imNotice.peerId)
    : null;
  const imStatusText = imNotice
    ? `${noticeFriend?.displayName || noticeFriend?.username || noticeConversation?.peerDisplayName || 'New'}`
    : '';

  const toggleAlwaysOnTop = async () => {
    const next = !alwaysOnTop;
    setAlwaysOnTop(next);
    try {
      const actual = await window.electronAPI?.setAlwaysOnTop?.(next);
      setAlwaysOnTop(Boolean(actual));
    } catch {
      setAlwaysOnTop(!next);
    }
  };

  const dismissReleaseNotes = () => {
    setReleaseNotesOpen(false);
    if (version) window.electronAPI?.setConfig('lastSeenReleaseNotesVersion', version).catch(() => {});
  };

  return (
    <ErrorBoundary>
      <div className="app-container">
        {/* Title bar */}
        <div className="toolbar" ref={toolbarRef}>
          <div className="toolbar-left">
            <img src="./icon.png" className="toolbar-icon" alt="" />
            <span className="toolbar-title">Neck Code</span>
            <span className="toolbar-version" style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>v{version}</span>
          </div>
          <div className="toolbar-center" />
          <div className="toolbar-right">
            <button
              className={`im-island-btn ${mainMode === 'im' ? 'active' : ''} ${imNotice ? 'has-unread' : ''}`}
              onClick={() => {
                if (mainMode === 'im') {
                  setMainMode('agent');
                } else {
                  setImNotice(null);
                  setMainMode('im');
                }
              }}
              title="IM Beta：测试中，功能可能不稳定"
            >
              <span className="im-island-label">IM</span>
              <span className="im-island-beta">Beta</span>
              {imStatusText && <span className="im-island-status">{imStatusText}</span>}
              {imNotice && <span className="im-island-count">{imNotice.count > 99 ? '99+' : imNotice.count}</span>}
            </button>
            <button className="toolbar-btn" onClick={() => setAgentOpen(true)}>
              Agent
            </button>
            <button className="toolbar-btn" onClick={() => setSkillsOpen(true)}>
              技能
            </button>
            <button className="toolbar-btn" onClick={() => setMemoryOpen(true)}>
              记忆
            </button>
            <button className="toolbar-btn" onClick={() => setSettingsOpen(true)}>
              设置
            </button>
            <div className="appearance-menu-wrap" ref={appearanceRef}>
              <button
                className={`toolbar-btn ${appearanceOpen ? 'active' : ''}`}
                onClick={() => setAppearanceOpen(v => !v)}
              >
                外观
              </button>
              {appearanceOpen && (
                <div className="appearance-menu">
                  <div className="appearance-menu-title">配色方案</div>
                  {theme === 'dark' ? (
                    <div className="appearance-menu-note">深色模式使用固定配色：夜蓝</div>
                  ) : (
                    <>
                      {LIGHT_SCHEMES.map(scheme => (
                        <button
                          key={scheme.id}
                          className={`appearance-option ${lightScheme === scheme.id ? 'active' : ''}`}
                          type="button"
                          onClick={() => applyLightScheme(scheme.id)}
                        >
                          <span className="appearance-swatch">
                            {scheme.palette.slice(0, 3).map(color => (
                              <i key={color} style={{ background: color }} />
                            ))}
                          </span>
                          <span>{scheme.name}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
            <button
              className="toolbar-btn"
              onClick={() => { const t = theme === 'dark' ? 'light' as const : 'dark' as const; setTheme(t); window.electronAPI?.setConfig('theme', t); }}
              title="切换主题"
            >
              {theme === 'dark' ? '\u2600' : '\u263E'}
            </button>
            <button
              className={`toolbar-btn pin-window-btn ${alwaysOnTop ? 'active' : ''}`}
              onClick={toggleAlwaysOnTop}
              title={alwaysOnTop ? '取消窗口置顶' : '窗口置顶'}
            >
              <span className="pin-window-icon" aria-hidden="true" />
            </button>
            <button
              className={`toolbar-btn icon-btn ${showSidebar ? 'active' : ''}`}
              onClick={toggleSidebar}
              title="代码面板"
            >
              <span className="icon-lines">
                <i /><i /><i />
              </span>
            </button>
            <div className="window-controls">
              <button className="window-btn" onClick={handleMinimize}>—</button>
              <button className="window-btn" onClick={handleMaximize}>□</button>
              <button className="window-btn close" onClick={handleClose}>×</button>
            </div>
          </div>
        </div>

        {/* Main content */}
        {(() => {
          if (mainMode === 'im') {
            return <ImShell />;
          }
          if (showSidebar) {
            return (
              <div className="code-panel-full">
                <div className="code-panel-topbar">
                  <WorkspaceBar />
                  <button className="toolbar-btn code-panel-close" onClick={toggleSidebar} title="返回聊天">
                    <span style={{ fontSize: 18 }}>←</span>
                  </button>
                </div>
                <div className="code-panel-body">
                  <div className="code-panel-left" style={{ width: codeLeftWidth }}>
                    <FileTree />
                  </div>
                  <ResizeHandle direction="left" onResize={handleCodeResize} />
                  <div className="code-panel-right">
                    <EditorTabs />
                    <EditorPanel />
                  </div>
                </div>
              </div>
            );
          }
          return (
            <div className="main-content">
              {showSessions && (
                <>
                  <div className="sidebar-left" style={{ width: leftWidth }}>
                    <SessionList />
                    <div className="sidebar-left-bottom">
                      <UpdateBanner />
                      <ContextBar />
                    </div>
                  </div>
                  <ResizeHandle direction="left" onResize={setLeftWidth} />
                </>
              )}
              {!showSessions && (
                <button className="session-rail-toggle" onClick={toggleSessions} title="展开会话列表">{'\u2630'}</button>
              )}

              <div className="chat-main">
                <ChatPanel />
              </div>
            </div>
          );
        })()}

        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <SkillsDialog open={skillsOpen} onClose={() => setSkillsOpen(false)} />
        <MemoryDialog open={memoryOpen} onClose={() => setMemoryOpen(false)} />
        <AgentDialog open={agentOpen} onClose={() => setAgentOpen(false)} />
        <ImageViewer open={!!viewerSrc} src={viewerSrc || ''} onClose={() => setViewerSrc(null)} />
        <CloseDialog />
        <AskDialog />
        {releaseNotesOpen && (
          <div className="close-dialog-overlay">
            <div className="whats-new-dialog">
              <h3>Neck Code v{version}</h3>
              <p>本次更新包含 IM 消息提醒、图片收发、已读状态、悬浮输入框 Ctrl 双击修复，以及 IM Agent 接管配置入口。</p>
              <div className="whats-new-list">
                <div>IM 新消息和 Agent 任务完成时，最小化窗口会在任务栏闪烁提醒。</div>
                <div>IM 输入框支持粘贴图片，消息气泡可直接预览图片。</div>
                <div>IM Agent 默认关闭，可在配置中逐步开放只读上下文能力。</div>
              </div>
              <div className="close-dialog-buttons">
                <button className="btn-send" onClick={dismissReleaseNotes}>我知道了</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}
