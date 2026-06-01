export const CODEX_COLLAB_MODELS = [
  { value: '', label: 'Codex 默认配置' },
  { value: 'gpt-5.5', label: 'gpt-5.5' },
  { value: 'gpt-5.1', label: 'gpt-5.1' },
  { value: 'gpt-5', label: 'gpt-5' },
  { value: 'gpt-5-codex', label: 'gpt-5-codex' },
  { value: 'o3', label: 'o3' },
  { value: 'o4-mini', label: 'o4-mini' },
] as const;

export type CollabCodexModel = (typeof CODEX_COLLAB_MODELS)[number]['value'];

export function isCollabCodexModel(value: unknown): value is CollabCodexModel {
  return CODEX_COLLAB_MODELS.some(option => option.value === value);
}
