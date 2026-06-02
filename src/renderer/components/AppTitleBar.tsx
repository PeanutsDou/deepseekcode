import React from 'react';
import { LIGHT_SCHEMES, type LightSchemeId } from '../theme-schemes';

interface AppTitleBarProps {
  version: string;
  mainMode: 'agent' | 'im';
  imStatusText: string;
  imNotice: { peerId: string; count: number } | null;
  theme: 'light' | 'dark';
  lightScheme: LightSchemeId;
  appearanceOpen: boolean;
  appearanceRef: React.RefObject<HTMLDivElement>;
  alwaysOnTop: boolean;
  showSidebar: boolean;
  onToggleImMode: () => void;
  onOpenAgent: () => void;
  onOpenSkills: () => void;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
  onToggleAppearance: () => void;
  onApplyLightScheme: (scheme: LightSchemeId) => void;
  onToggleTheme: () => void;
  onToggleAlwaysOnTop: () => void;
  onToggleSidebar: () => void;
}

function minimizeWindow() {
  window.electronAPI?.minimize?.();
}

function toggleMaximizeWindow() {
  window.electronAPI?.maximize?.();
}

function closeWindow() {
  window.electronAPI?.close?.();
}

function isToolbarControl(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  return Boolean(el?.closest([
    'button',
    'input',
    'select',
    'textarea',
    'a',
    '[role="button"]',
    '.appearance-menu',
    '.window-controls',
  ].join(',')));
}

export function AppTitleBar({
  version,
  mainMode,
  imStatusText,
  imNotice,
  theme,
  lightScheme,
  appearanceOpen,
  appearanceRef,
  alwaysOnTop,
  showSidebar,
  onToggleImMode,
  onOpenAgent,
  onOpenSkills,
  onOpenMemory,
  onOpenSettings,
  onToggleAppearance,
  onApplyLightScheme,
  onToggleTheme,
  onToggleAlwaysOnTop,
  onToggleSidebar,
}: AppTitleBarProps) {
  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isToolbarControl(event.target)) return;
    toggleMaximizeWindow();
  };

  return (
    <div className="toolbar" onDoubleClick={handleDoubleClick}>
      <div className="toolbar-left">
        <img src="./icon.png" className="toolbar-icon" alt="" />
        <span className="toolbar-title">Neck Code</span>
        <span className="toolbar-version">v{version}</span>
      </div>
      <div className="toolbar-center" />
      <div className="toolbar-right">
        <button
          className={`im-island-btn ${mainMode === 'im' ? 'active' : ''} ${imNotice ? 'has-unread' : ''}`}
          onClick={onToggleImMode}
          title="IM Beta：测试中，功能可能不稳定"
        >
          <span className="im-island-label">IM</span>
          <span className="im-island-beta">Beta</span>
          {imStatusText && <span className="im-island-status">{imStatusText}</span>}
          {imNotice && <span className="im-island-count">{imNotice.count > 99 ? '99+' : imNotice.count}</span>}
        </button>
        <button className="toolbar-btn" onClick={onOpenAgent}>Agent</button>
        <button className="toolbar-btn" onClick={onOpenSkills}>技能</button>
        <button className="toolbar-btn" onClick={onOpenMemory}>记忆</button>
        <button className="toolbar-btn" onClick={onOpenSettings}>设置</button>
        <div className="appearance-menu-wrap" ref={appearanceRef}>
          <button
            className={`toolbar-btn ${appearanceOpen ? 'active' : ''}`}
            onClick={onToggleAppearance}
          >
            外观
          </button>
          {appearanceOpen && (
            <div className="appearance-menu">
              <div className="appearance-menu-title">配色方案</div>
              {theme === 'dark' ? (
                <div className="appearance-menu-note">深色模式使用固定配色：夜蓝</div>
              ) : (
                LIGHT_SCHEMES.map(scheme => (
                  <button
                    key={scheme.id}
                    className={`appearance-option ${lightScheme === scheme.id ? 'active' : ''}`}
                    type="button"
                    onClick={() => onApplyLightScheme(scheme.id)}
                  >
                    <span className="appearance-swatch">
                      {scheme.palette.slice(0, 3).map(color => (
                        <i key={color} style={{ background: color }} />
                      ))}
                    </span>
                    <span>{scheme.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button
          className="toolbar-btn"
          onClick={onToggleTheme}
          title="切换主题"
        >
          {theme === 'dark' ? '\u2600' : '\u263E'}
        </button>
        <button
          className={`toolbar-btn pin-window-btn ${alwaysOnTop ? 'active' : ''}`}
          onClick={onToggleAlwaysOnTop}
          title={alwaysOnTop ? '取消窗口置顶' : '窗口置顶'}
        >
          <span className="pin-window-icon" aria-hidden="true" />
        </button>
        <button
          className={`toolbar-btn icon-btn ${showSidebar ? 'active' : ''}`}
          onClick={onToggleSidebar}
          title="代码面板"
        >
          <span className="icon-lines">
            <i /><i /><i />
          </span>
        </button>
        <div className="window-controls">
          <button className="window-btn" onClick={minimizeWindow}>-</button>
          <button className="window-btn" onClick={toggleMaximizeWindow}>□</button>
          <button className="window-btn close" onClick={closeWindow}>×</button>
        </div>
      </div>
    </div>
  );
}
