import React, { useMemo, useState } from 'react';
import { ExpandableText } from './ExpandableText';

export interface CollabArtifactView {
  id: string;
  type: string;
  path: string;
  createdAt: number;
}

interface Props {
  taskId: string;
  artifact: CollabArtifactView;
}

const ARTIFACT_LABELS: Record<string, string> = {
  brief: 'Codex 简报',
  result: '执行摘要',
  diff: 'Diff',
  test_output: '验证输出',
  review: 'Codex 审查',
  codex_plan_log: '规划日志',
  claude_log: '执行日志',
  codex_review_log: '审查日志',
  status: '状态',
};

function labelFor(type: string): string {
  return ARTIFACT_LABELS[type] || type;
}

function isMarkdown(type: string): boolean {
  return ['brief', 'result', 'review'].includes(type);
}

export function ArtifactPreviewButton({ taskId, artifact }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const filename = useMemo(() => artifact.path.split(/[\\/]/).pop() || artifact.type, [artifact.path, artifact.type]);

  const openPreview = async () => {
    setOpen(true);
    if (content || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.readCollabArtifact?.(taskId, artifact.id) as any;
      setContent(String(result?.content || ''));
      setTruncated(Boolean(result?.truncated));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button type="button" className={`artifact-chip artifact-chip-${artifact.type}`} onClick={openPreview} title={filename}>
        {labelFor(artifact.type)}
      </button>
      {open && (
        <div className="artifact-preview-overlay" onClick={() => setOpen(false)}>
          <div className="artifact-preview-dialog" onClick={e => e.stopPropagation()}>
            <div className="artifact-preview-header">
              <div>
                <strong>{labelFor(artifact.type)}</strong>
                <span>{filename}</span>
              </div>
              <button type="button" className="settings-close" onClick={() => setOpen(false)}>&times;</button>
            </div>
            <div className="artifact-preview-body">
              {loading && <div className="artifact-preview-state">读取中...</div>}
              {error && <div className="artifact-preview-error">{error}</div>}
              {!loading && !error && (
                <>
                  {truncated && <div className="artifact-preview-warning">文件较大，已显示前 1MB 内容。</div>}
                  <ExpandableText
                    text={content || '无内容'}
                    markdown={isMarkdown(artifact.type)}
                    collapsedChars={8000}
                    className={isMarkdown(artifact.type) ? 'artifact-markdown' : 'artifact-mono'}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
