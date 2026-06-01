import React, { useState, useEffect, useCallback } from 'react';
import type { CollabCliCheckResult, CollabConfig, ProviderTestResult } from '../../shared/types';
import { CODEX_COLLAB_MODELS } from '../../shared/collab';
import { useCollabStore } from '../stores/collab-store';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ProviderItem {
  id: string;
  name: string;
  models: string[];
}

interface ModelRow {
  name: string;
  contextLimit: number;
  maxTokens: number;
  mode: 'text' | 'multimodal';
}

interface BalanceInfo {
  total: string;
  toppedUp?: string;
  granted?: string;
  currency: string;
}

interface QuickLauncherSettings {
  enabled: boolean;
  triggerWindowMs: number;
  inputAutoHideMs: number;
  panelAutoHideMs: number;
  modelId: string;
  findMaxDepth: number;
}

export function SettingsDialog({ open, onClose }: Props) {
  const setGlobalCollabConfig = useCollabStore(s => s.setConfig);
  const setGlobalCollabCheck = useCollabStore(s => s.setCliCheck);
  const [providerList, setProviderList] = useState<ProviderItem[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editApiKey, setEditApiKey] = useState('');
  const [editModels, setEditModels] = useState<ModelRow[]>([]);
  const [addingModel, setAddingModel] = useState(false);
  const [newModelName, setNewModelName] = useState('');
  const [newModelCtx, setNewModelCtx] = useState(0);
  const [newModelMax, setNewModelMax] = useState(32768);
  const [newModelMode, setNewModelMode] = useState<'text' | 'multimodal'>('text');
  const [editingModelIdx, setEditingModelIdx] = useState<number | null>(null);
  const [testingProvider, setTestingProvider] = useState(false);
  const [providerTest, setProviderTest] = useState<ProviderTestResult | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [petEnabled, setPetEnabled] = useState(true);
  const [petTheme, setPetTheme] = useState('clawd');
  const [qlExpanded, setQlExpanded] = useState(false);
  const [quickLauncher, setQuickLauncher] = useState<QuickLauncherSettings>({
    enabled: true,
    triggerWindowMs: 400,
    inputAutoHideMs: 5000,
    panelAutoHideMs: 10000,
    modelId: 'deepseek-v4-flash',
    findMaxDepth: 4,
  });
  const [collabConfig, setCollabConfig] = useState<CollabConfig | null>(null);
  const [collabCheck, setCollabCheck] = useState<CollabCliCheckResult | null>(null);
  const [collabChecking, setCollabChecking] = useState(false);
  const [collabError, setCollabError] = useState<string | null>(null);
  const [collabModelsOpen, setCollabModelsOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    loadConfig();
  }, [open]);

  const loadConfig = async () => {
    try {
      const cfg = await window.electronAPI.getConfig() as any;
      const list = cfg.providers || [];
      setProviderList(list.map((p: any) => ({ id: p.id, name: p.name, models: Array.isArray(p.models) ? p.models.map((m: any) => typeof m === 'string' ? m : m.name) : [] })));
      setAutoLaunch(Boolean(cfg.autoLaunch));
      window.electronAPI.getAutoLaunch?.().then((enabled: boolean) => setAutoLaunch(Boolean(enabled))).catch(() => {});
      // Pet state
      window.electronAPI.getPetStatus?.().then((enabled: boolean) => setPetEnabled(Boolean(enabled))).catch(() => {});
      window.electronAPI.getPetTheme?.().then((t: string) => setPetTheme(t || 'clawd')).catch(() => {});
      const quick = cfg.quickLauncher || {};
      setCollabConfig(cfg.collab || null);
      setGlobalCollabConfig(cfg.collab || null);
      setQuickLauncher({
        enabled: quick.enabled !== false,
        triggerWindowMs: typeof quick.triggerWindowMs === 'number' ? quick.triggerWindowMs : 400,
        inputAutoHideMs: typeof quick.inputAutoHideMs === 'number' ? quick.inputAutoHideMs : 5000,
        panelAutoHideMs: typeof quick.panelAutoHideMs === 'number' ? quick.panelAutoHideMs : 10000,
        modelId: typeof quick.modelId === 'string' ? quick.modelId : 'deepseek-v4-flash',
        findMaxDepth: typeof quick.findMaxDepth === 'number' ? quick.findMaxDepth : 4,
      });
    } catch { /* */ }
  };

  const updateCollab = async (patch: Partial<CollabConfig>) => {
    const base = collabConfig || await window.electronAPI.getCollabConfig();
    const next = { ...base, ...patch };
    const cliCommandChanged = patch.codexCommand !== undefined || patch.claudeCommand !== undefined;
    setCollabConfig(next);
    setCollabError(null);
    if (cliCommandChanged) {
      setCollabCheck(null);
      setGlobalCollabCheck(null);
    }
    try {
      const saved = await window.electronAPI.setCollabConfig(next);
      setCollabConfig(saved);
      setGlobalCollabConfig(saved);
    } catch (err) {
      setCollabError(err instanceof Error ? err.message : String(err));
      const saved = await window.electronAPI.getCollabConfig();
      setCollabConfig(saved);
      setGlobalCollabConfig(saved);
    }
  };

  const checkCollab = async () => {
    if (!collabConfig) return;
    setCollabChecking(true);
    setCollabError(null);
    try {
      const result = await window.electronAPI.checkCollabCli(collabConfig);
      setCollabCheck(result);
      setGlobalCollabCheck(result);
      if (!result.ok && collabConfig.enabled) {
        const saved = await window.electronAPI.getCollabConfig();
        setCollabConfig(saved);
        setGlobalCollabConfig(saved);
      }
    } catch (err) {
      setCollabError(err instanceof Error ? err.message : String(err));
    } finally {
      setCollabChecking(false);
    }
  };

  const updateQuickLauncher = async (patch: Partial<QuickLauncherSettings>) => {
    const next = { ...quickLauncher, ...patch };
    setQuickLauncher(next);
    await window.electronAPI.setConfig('quickLauncher', next);
  };

  const updateAutoLaunch = async (enabled: boolean) => {
    setAutoLaunch(enabled);
    const actual = await window.electronAPI.setAutoLaunch?.(enabled).catch(() => !enabled);
    if (typeof actual === 'boolean') setAutoLaunch(actual);
  };

  const inferModelMode = (name: string): 'text' | 'multimodal' => {
    const lower = name.toLowerCase();
    const multimodalPatterns = [
      'vision',
      'multimodal',
      'omni',
      'gpt-4o',
      'gpt-4.1',
      'gpt-5',
      'gemini',
      'qwen-vl',
      'qwen2-vl',
      'qwen2.5-vl',
      'qwen-omni',
      'vl',
      'claude-3',
      'claude-sonnet-4',
      'claude-haiku-4',
      'claude-opus-4',
    ];
    return multimodalPatterns.some(pattern => lower.includes(pattern)) ? 'multimodal' : 'text';
  };

  useEffect(() => {
    if (!addingModel || editingModelIdx !== null) return;
    setNewModelMode(inferModelMode(newModelName));
  }, [newModelName, addingModel, editingModelIdx]);

  const startEdit = async (id: string) => {
    const cfg = await window.electronAPI.getConfig() as any;
    const fullProviders = cfg.providers || [];
    const full = fullProviders.find((fp: any) => fp.id === id) || {};
    const models: ModelRow[] = (full.models || []).map((m: any) => ({
      name: typeof m === 'string' ? m : m.name,
      contextLimit: (typeof m === 'object' ? m.contextLimit : undefined) || 0,
      maxTokens: (typeof m === 'object' ? m.maxTokens : undefined) || 32768,
      mode: (typeof m === 'object' && (m.mode === 'text' || m.mode === 'multimodal')) ? m.mode : inferModelMode(typeof m === 'string' ? m : m.name),
    }));
    setEditingId(id);
    setEditName(full.name || id);
    setEditBaseUrl(full.baseUrl || '');
    setEditApiKey(full.apiKey || '');
    setEditModels(models);
    setAddingModel(false);
    setEditingModelIdx(null);
    setProviderTest(null);
    setBalance(null);
    setBalanceError(null);
  };

  const startNew = () => {
    setEditingId('__new__');
    setEditName('');
    setEditBaseUrl('https://api.openai.com/v1');
    setEditApiKey('');
    setEditModels([]);
    setAddingModel(false);
    setEditingModelIdx(null);
    setProviderTest(null);
    setBalance(null);
    setBalanceError(null);
  };

  const cancelEdit = () => { setEditingId(null); };

  const handleAddModel = () => {
    if (!newModelName.trim()) return;
    if (editModels.some(m => m.name === newModelName.trim())) {
      setNewModelName('');
      return;
    }
    setEditModels([...editModels, {
      name: newModelName.trim(),
      contextLimit: newModelCtx || 0,
      maxTokens: newModelMax || 32768,
      mode: newModelMode,
    }]);
    setNewModelName('');
    setNewModelCtx(0);
    setNewModelMax(32768);
    setNewModelMode('text');
    setAddingModel(false);
  };

  const handleDeleteModel = (idx: number) => {
    setEditModels(editModels.filter((_, i) => i !== idx));
    if (editingModelIdx === idx) setEditingModelIdx(null);
  };

  const handleEditModel = (idx: number) => {
    const m = editModels[idx];
    setNewModelName(m.name);
    setNewModelCtx(m.contextLimit);
    setNewModelMax(m.maxTokens);
    setNewModelMode(m.mode || inferModelMode(m.name));
    setEditingModelIdx(idx);
    setAddingModel(true);
  };

  const handleSaveModelEdit = () => {
    if (!newModelName.trim() || editingModelIdx === null) return;
    const updated = [...editModels];
    updated[editingModelIdx] = {
      name: newModelName.trim(),
      contextLimit: newModelCtx || 0,
      maxTokens: newModelMax || 32768,
      mode: newModelMode,
    };
    setEditModels(updated);
    setNewModelName('');
    setNewModelCtx(0);
    setNewModelMax(32768);
    setNewModelMode('text');
    setAddingModel(false);
    setEditingModelIdx(null);
  };

  const saveProvider = async () => {
    if (!editName.trim()) return;
    const id = editingId === '__new__'
      ? (editName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || `provider_${Date.now()}`)
      : editingId!;
    const models = editModels.map(m => ({
      name: m.name,
      contextLimit: m.contextLimit || undefined,
      maxTokens: m.maxTokens || undefined,
      mode: m.mode || inferModelMode(m.name),
    }));
    const isNew = editingId === '__new__';
    const apiKeyValue = isNew ? editApiKey.trim() : (editApiKey.trim() || undefined);
    await window.electronAPI.setProvider({ id, name: editName.trim(), baseUrl: editBaseUrl.trim() || undefined, apiKey: apiKeyValue, models } as any);
    setEditingId(null);
    loadConfig();
    window.dispatchEvent(new CustomEvent('providers-changed'));
  };

  const fetchBalance = useCallback(async () => {
    if (!editApiKey.trim() || !editBaseUrl.trim()) return;
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const result = await window.electronAPI.testProvider({
        name: editName.trim(),
        baseUrl: editBaseUrl.trim(),
        apiKey: editApiKey.trim(),
        model: editModels[0]?.name || 'gpt-3.5-turbo',
      });
      if (result?.balance) {
        setBalance(result.balance);
      } else {
        setBalanceError('不支持余额查询');
      }
    } catch (err) {
      setBalanceError(err instanceof Error ? err.message : String(err));
    } finally {
      setBalanceLoading(false);
    }
  }, [editApiKey, editBaseUrl, editName, editModels]);

  // Auto-fetch balance when switching to a provider
  useEffect(() => {
    if (!editingId || editingId === '__new__') return;
    if (!editApiKey.trim()) return;
    setBalance(null);
    setBalanceError(null);
    fetchBalance();
  }, [editingId, fetchBalance, editApiKey]);

  const testProvider = async () => {
    const model = editModels[0]?.name || newModelName.trim();
    setTestingProvider(true);
    setProviderTest(null);
    try {
      const result = await window.electronAPI.testProvider({
        providerId: editingId === '__new__' ? undefined : editingId || undefined,
        name: editName.trim(),
        baseUrl: editBaseUrl.trim(),
        apiKey: editApiKey.trim(),
        model,
      });
      setProviderTest(result);
      // Also update balance from test result
      if (result?.balance) setBalance(result.balance);
    } catch (err) {
      setProviderTest({
        status: 'fail',
        summary: '诊断请求失败。',
        checks: [{ id: 'runtime', label: '运行时', status: 'fail', message: err instanceof Error ? err.message : String(err) }],
      });
    } finally {
      setTestingProvider(false);
    }
  };

  const deleteProvider = async (id: string) => {
    if (!window.confirm(`确定删除供应商 "${id}"？`)) return;
    await (window.electronAPI as any).deleteProvider?.(id);
    loadConfig();
    window.dispatchEvent(new CustomEvent('providers-changed'));
  };

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog settings-dialog-wide" onClick={e => e.stopPropagation()} style={{ maxHeight: '85vh' }}>
        <div className="settings-header">
          <h2>设置</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="settings-body settings-body-row">
          {/* Left: providers list */}
          <div className="settings-left">
            <div className="settings-form">
              <div className="provider-list">
                {providerList.map(p => (
                  <div key={p.id} className={`provider-item ${editingId === p.id ? 'selected' : ''}`} onClick={() => startEdit(p.id)}>
                    <div className="provider-info">
                      <span className="provider-name">{p.name}</span>
                      <span className="provider-models">{p.models.join(', ')}</span>
                    </div>
                    <div className="provider-actions" onClick={e => e.stopPropagation()}>
                      <button className="settings-btn-sm danger" onClick={() => deleteProvider(p.id)}>×</button>
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn btn-send" onClick={startNew} style={{ width: '100%', marginTop: 8 }}>＋ 添加供应商</button>
              <div className="quick-settings-card">
                <div className="quick-settings-title">启动</div>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={autoLaunch}
                    onChange={e => void updateAutoLaunch(e.target.checked)}
                  />
                  开机自启动（后台启动并最小化到托盘）
                </label>
              </div>
              <div className="quick-settings-card">
                <div className="quick-settings-title">🦀 桌宠</div>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={petEnabled}
                    onChange={e => {
                      setPetEnabled(e.target.checked);
                      window.electronAPI.togglePet?.().catch(() => {});
                    }}
                  />
                  显示桌面宠物
                </label>
                <label className="settings-label">宠物选择
                  <select
                    className="settings-input"
                    value={petTheme}
                    onChange={e => {
                      setPetTheme(e.target.value);
                      window.electronAPI.setPetTheme?.(e.target.value).catch(() => {});
                    }}
                  >
                    <option value="clawd">🦀 Clawd 螃蟹</option>
                    <option value="calico">🐱 Calico 三花猫</option>
                    <option value="cloudling">☁️ Cloudling 云宝</option>
                  </select>
                </label>
              </div>
              <div className="quick-settings-card">
                <div className="quick-settings-title" onClick={() => setQlExpanded(!qlExpanded)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  {qlExpanded ? '▼' : '▶'} QuickLauncher
                </div>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={quickLauncher.enabled}
                    onChange={e => void updateQuickLauncher({ enabled: e.target.checked })}
                  />
                  双击 Ctrl 唤起
                </label>
                {qlExpanded && (
                  <>
                <label className="settings-label">双击判定窗口(ms)
                  <input
                    type="number"
                    className="settings-input"
                    min={150}
                    max={1200}
                    value={quickLauncher.triggerWindowMs}
                    onChange={e => void updateQuickLauncher({ triggerWindowMs: Number(e.target.value) || 400 })}
                  />
                </label>
                <label className="settings-label">悬浮输入框模型
                  <select
                    className="settings-input"
                    value={quickLauncher.modelId}
                    onChange={e => void updateQuickLauncher({ modelId: e.target.value })}
                  >
                    {providerList.flatMap(provider => provider.models).map(model => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </label>
                <label className="settings-label">输入框自动隐藏(ms)
                  <input
                    type="number"
                    className="settings-input"
                    min={1000}
                    max={60000}
                    value={quickLauncher.inputAutoHideMs}
                    onChange={e => void updateQuickLauncher({ inputAutoHideMs: Number(e.target.value) || 5000 })}
                  />
                </label>
                <label className="settings-label">对话框自动隐藏(ms)
                  <input
                    type="number"
                    className="settings-input"
                    min={1000}
                    max={120000}
                    value={quickLauncher.panelAutoHideMs}
                    onChange={e => void updateQuickLauncher({ panelAutoHideMs: Number(e.target.value) || 10000 })}
                  />
                </label>
                <label className="settings-label">本地检索深度
                  <input
                    type="number"
                    className="settings-input"
                    min={1}
                    max={8}
                    value={quickLauncher.findMaxDepth}
                    onChange={e => void updateQuickLauncher({ findMaxDepth: Number(e.target.value) || 4 })}
                  />
                </label>
                  </>
                )}
              </div>
              {collabConfig && (
                <div className="quick-settings-card">
                  <div className="quick-settings-title">模型协同</div>
                  <label className="settings-label">Codex CLI
                    <input
                      className="settings-input"
                      value={collabConfig.codexCommand}
                      onChange={e => setCollabConfig({ ...collabConfig, codexCommand: e.target.value })}
                      onBlur={() => void updateCollab({ codexCommand: collabConfig.codexCommand, enabled: false })}
                    />
                  </label>
                  <label className="settings-label">Claude Code CLI
                    <input
                      className="settings-input"
                      value={collabConfig.claudeCommand}
                      onChange={e => setCollabConfig({ ...collabConfig, claudeCommand: e.target.value })}
                      onBlur={() => void updateCollab({ claudeCommand: collabConfig.claudeCommand, enabled: false })}
                    />
                  </label>
                  <div className="collab-model-config-row">
                    <button
                      type="button"
                      className="settings-btn-sm"
                      onClick={() => setCollabModelsOpen(v => !v)}
                    >
                      {collabModelsOpen ? '收起协同模型配置' : '配置协同模型'}
                    </button>
                    <span>
                      Claude: {collabConfig.claudeModel} · Codex: {collabConfig.codexModel || '默认配置'} / {collabConfig.codexEffort}
                    </span>
                  </div>
                  {collabModelsOpen && (
                    <div className="collab-model-config-panel">
                      <label className="settings-label">Claude 执行模型
                        <select
                          className="settings-input"
                          value={collabConfig.claudeModel}
                          onChange={e => void updateCollab({ claudeModel: e.target.value })}
                        >
                          <option value="deepseek-v4-pro">deepseek-v4-pro</option>
                          <option value="deepseek-v4-flash">deepseek-v4-flash</option>
                        </select>
                      </label>
                      <div className="settings-hint">Claude Code 思考力度固定为 max。</div>
                      <label className="settings-label">Codex 模型
                        <select
                          className="settings-input"
                          value={collabConfig.codexModel}
                          onChange={e => void updateCollab({ codexModel: e.target.value as CollabConfig['codexModel'] })}
                        >
                          {CODEX_COLLAB_MODELS.map(model => (
                            <option key={model.value || 'default'} value={model.value}>{model.label}</option>
                          ))}
                        </select>
                      </label>
                      <div className="settings-hint">Codex 规划和审查共用同一个模型。</div>
                      <label className="settings-label">Codex 思考力度
                        <select
                          className="settings-input"
                          value={collabConfig.codexEffort}
                          onChange={e => void updateCollab({ codexEffort: e.target.value as CollabConfig['codexEffort'] })}
                        >
                          <option value="minimal">minimal</option>
                          <option value="low">low</option>
                          <option value="medium">medium</option>
                          <option value="high">high</option>
                        </select>
                      </label>
                    </div>
                  )}
                  <button className="settings-btn-sm" onClick={checkCollab} disabled={collabChecking}>
                    {collabChecking ? '检测中...' : '检测 Codex / Claude Code'}
                  </button>
                  {collabCheck && (
                    <div className={`collab-check-result ${collabCheck.ok ? 'ok' : 'fail'}`}>
                      <div>Codex: {collabCheck.codex.ok ? '可用' : '不可用'}</div>
                      <div>Claude Code: {collabCheck.claude.ok ? '可用' : '不可用'}</div>
                      {!collabCheck.ok && <span>任一 CLI 不可调用时，主界面协同开关会保持禁用。</span>}
                    </div>
                  )}
                  {collabError && <div className="balance-error">{collabError}</div>}
                </div>
              )}
            </div>
          </div>

          {/* Right: edit form */}
          <div className="settings-right">
            {!editingId ? (
              <div className="settings-placeholder">选择一个供应商编辑，或添加新的</div>
            ) : (
              <div className="provider-edit">
                <h4>{editingId === '__new__' ? '新建供应商' : '编辑 ' + editName}</h4>
                <label className="settings-label">名称
                  <input type="text" className="settings-input" value={editName}
                    onChange={e => setEditName(e.target.value)} placeholder="例：硅基流动" />
                </label>
                <label className="settings-label">接口地址 (Base URL)
                  <input type="text" className="settings-input" value={editBaseUrl}
                    onChange={e => setEditBaseUrl(e.target.value)} placeholder="https://api.siliconflow.cn/v1" />
                </label>
                <label className="settings-label">API 密钥
                  <input type="password" className="settings-input" value={editApiKey}
                    onChange={e => setEditApiKey(e.target.value)} placeholder="sk-..." />
                </label>

                {/* Persistent balance card */}
                {editApiKey.trim() && (
                  <div className="balance-card">
                    <div className="balance-card-header">
                      <span>💰 账户余额</span>
                      <button className="settings-btn-sm" onClick={fetchBalance} disabled={balanceLoading}>
                        {balanceLoading ? '查询中...' : '刷新'}
                      </button>
                    </div>
                    {balanceError ? (
                      <div className="balance-error">{balanceError}</div>
                    ) : balance ? (
                      <div className="balance-info">
                        <div className="balance-row">
                          <span>总余额</span>
                          <strong>{balance.total} {balance.currency}</strong>
                        </div>
                        {balance.toppedUp && (
                          <div className="balance-row">
                            <span>充值余额</span>
                            <span>{balance.toppedUp}</span>
                          </div>
                        )}
                        {balance.granted && (
                          <div className="balance-row">
                            <span>赠送余额</span>
                            <span>{balance.granted}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="balance-loading">加载中...</div>
                    )}
                  </div>
                )}

                <div className="settings-label" style={{ marginTop: 8 }}>模型列表</div>
                <div className="model-list">
                  {editModels.map((m, i) => (
                    <div key={m.name + i} className="model-row">
                      <span className="model-name">{m.name}</span>
                      <span className="model-mode">{m.mode === 'multimodal' ? '多模态' : '纯文本'}</span>
                      <span className="model-meta">
                        ctx: {m.contextLimit > 0 ? `${(m.contextLimit / 1000).toFixed(0)}K` : 'default'} · max: {m.maxTokens > 0 ? `${(m.maxTokens / 1024).toFixed(0)}K` : 'default'}
                      </span>
                      <button className="settings-btn-sm" onClick={() => handleEditModel(i)}>编辑</button>
                      <button className="settings-btn-sm danger" onClick={() => handleDeleteModel(i)}>×</button>
                    </div>
                  ))}
                  {editModels.length === 0 && !addingModel && (
                    <div className="model-row empty">尚未添加模型</div>
                  )}
                </div>

                {addingModel && (
                  <div className="model-add-row">
                    <input type="text" className="settings-input" value={newModelName}
                      onChange={e => setNewModelName(e.target.value)} placeholder="模型名" style={{ flex: 2 }} />
                    <input type="number" className="settings-input" value={newModelCtx || ''}
                      onChange={e => setNewModelCtx(Number(e.target.value))} placeholder="上下文窗口" style={{ flex: 1 }} />
                    <input type="number" className="settings-input" value={newModelMax || ''}
                      onChange={e => setNewModelMax(Number(e.target.value))} placeholder="最大输出" style={{ flex: 1 }} />
                    <select className="settings-input" value={newModelMode}
                      onChange={e => setNewModelMode(e.target.value as 'text' | 'multimodal')} style={{ flex: 1 }}>
                      <option value="text">纯文本</option>
                      <option value="multimodal">多模态</option>
                    </select>
                    <button className="btn btn-send" onClick={editingModelIdx !== null ? handleSaveModelEdit : handleAddModel}>
                      {editingModelIdx !== null ? '更新' : '确认'}
                    </button>
                    <button className="settings-btn-sm" onClick={() => { setAddingModel(false); setEditingModelIdx(null); }}>取消</button>
                  </div>
                )}
                {!addingModel && (
                  <button className="settings-btn-sm" onClick={() => setAddingModel(true)} style={{ marginTop: 4 }}>＋ 添加模型</button>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn btn-send" onClick={saveProvider}>保存</button>
                  <button className="settings-btn-sm" onClick={testProvider} disabled={testingProvider || editModels.length === 0}>
                    {testingProvider ? '诊断中...' : '诊断'}
                  </button>
                  <button className="settings-btn-sm" onClick={cancelEdit}>取消</button>
                </div>
                {providerTest && (
                  <div className={`provider-test provider-test-${providerTest.status}`}>
                    <div className="provider-test-summary">{providerTest.summary}</div>
                    {providerTest.checks.map(check => (
                      <div key={check.id} className={`provider-test-check provider-test-check-${check.status}`}>
                        <span>{check.label}</span>
                        <strong>{check.status === 'pass' ? '通过' : check.status === 'warn' ? '警告' : '失败'}</strong>
                        <em>{check.message}</em>
                      </div>
                    ))}
                    {providerTest.suggestion && <div className="provider-test-suggestion">{providerTest.suggestion}</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
