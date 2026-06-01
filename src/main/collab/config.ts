import type { CollabConfig } from './types';
import { isCollabCodexModel } from '../../shared/collab';

export const DEFAULT_COLLAB_CONFIG: CollabConfig = {
  enabled: false,
  codexCommand: 'codex',
  claudeCommand: 'claude',
  codexModel: '',
  claudeModel: 'deepseek-v4-pro',
  codexEffort: 'high',
  writePolicy: 'workspaceLock',
};

function normalizeCodexEffort(value: unknown): CollabConfig['codexEffort'] {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high'
    ? value
    : DEFAULT_COLLAB_CONFIG.codexEffort;
}

function normalizeClaudeModel(value: unknown): string {
  return value === 'deepseek-v4-flash' || value === 'deepseek-v4-pro'
    ? value
    : DEFAULT_COLLAB_CONFIG.claudeModel;
}

function normalizeCodexModel(value: unknown): CollabConfig['codexModel'] {
  return isCollabCodexModel(value) ? value : DEFAULT_COLLAB_CONFIG.codexModel;
}

export function normalizeCollabConfig(input: unknown): CollabConfig {
  const raw = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  return {
    enabled: raw.enabled === true,
    codexCommand: typeof raw.codexCommand === 'string' && raw.codexCommand.trim()
      ? raw.codexCommand.trim()
      : DEFAULT_COLLAB_CONFIG.codexCommand,
    claudeCommand: typeof raw.claudeCommand === 'string' && raw.claudeCommand.trim()
      ? raw.claudeCommand.trim()
      : DEFAULT_COLLAB_CONFIG.claudeCommand,
    codexModel: normalizeCodexModel(typeof raw.codexModel === 'string' ? raw.codexModel.trim() : raw.codexModel),
    claudeModel: normalizeClaudeModel(raw.claudeModel),
    codexEffort: normalizeCodexEffort(raw.codexEffort),
    writePolicy: 'workspaceLock',
  };
}
