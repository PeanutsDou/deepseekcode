import React, { useEffect } from 'react';
import { refreshCollabState, useCollabStore } from '../stores/collab-store';

export function CollabModeToggle() {
  const config = useCollabStore(s => s.config);
  const cliCheck = useCollabStore(s => s.cliCheck);
  const checking = useCollabStore(s => s.checking);
  const setConfig = useCollabStore(s => s.setConfig);
  const setCliCheck = useCollabStore(s => s.setCliCheck);
  const setChecking = useCollabStore(s => s.setChecking);

  useEffect(() => {
    void refreshCollabState();
    const run = async () => {
      try {
        setChecking(true);
        const result = await window.electronAPI?.checkCollabCli?.();
        if (result) setCliCheck(result);
      } finally {
        setChecking(false);
      }
    };
    void run();
  }, [setChecking, setCliCheck]);

  if (!config) return null;
  const available = cliCheck?.ok === true;
  const disabled = checking || !available;
  const enabled = config.enabled && available;
  const title = available
    ? '切换模型协同模式'
    : '需要先在设置中检测并确认 Codex CLI 与 Claude Code CLI 可调用';

  const toggle = async () => {
    if (disabled) return;
    const next = { ...config, enabled: !enabled };
    try {
      const saved = await window.electronAPI.setCollabConfig(next);
      setConfig(saved);
      window.dispatchEvent(new CustomEvent('collab-config-changed'));
    } catch {
      const saved = await window.electronAPI.getCollabConfig();
      setConfig(saved);
    }
  };

  return (
    <button
      type="button"
      className={`collab-mode-toggle ${enabled ? 'enabled' : ''}`}
      disabled={disabled}
      onClick={toggle}
      title={title}
    >
      <span className="collab-toggle-label">协同</span>
      <span className="collab-toggle-track"><i /></span>
    </button>
  );
}
