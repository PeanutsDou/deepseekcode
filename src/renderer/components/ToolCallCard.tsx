import React, { useState } from 'react';

interface Props {
  toolName: string;
  toolArgs?: string;
  toolResult?: string;
}

const TOOL_META: Record<string, { icon: string; label: string; color: string }> = {
  read_file: { icon: 'R', label: 'Read', color: '#89b4fa' },
  write_file: { icon: 'W', label: 'Write', color: '#a6e3a1' },
  edit_file: { icon: 'E', label: 'Edit', color: '#a6e3a1' },
  list_dir: { icon: 'L', label: 'List', color: '#89b4fa' },
  delete_file: { icon: 'D', label: 'Delete', color: '#f38ba8' },
  run_shell: { icon: '>', label: 'Shell', color: '#6c7086' },
  glob: { icon: 'G', label: 'Glob', color: '#a6adc8' },
  grep: { icon: 'S', label: 'Grep', color: '#a6adc8' },
  web_fetch: { icon: 'F', label: 'Fetch', color: '#74c7ec' },
  web_search: { icon: 'Q', label: 'Search', color: '#74c7ec' },
  everything_search: { icon: 'E', label: 'Everything', color: '#74c7ec' },
  task_create: { icon: '+', label: 'Task +', color: '#a6adc8' },
  task_get: { icon: 'T', label: 'Task', color: '#a6adc8' },
  task_list: { icon: 'T', label: 'Tasks', color: '#a6adc8' },
  task_update: { icon: 'T', label: 'Task done', color: '#a6adc8' },
  notebook_edit: { icon: 'N', label: 'Notebook', color: '#a6adc8' },
  list_skills: { icon: '*', label: 'Skills', color: '#a6adc8' },
  invoke_skill: { icon: '*', label: 'Skill', color: '#a6adc8' },
  invoke_agent: { icon: 'A', label: 'Agent', color: '#6a8fba' },
  collab_tool: { icon: 'M', label: '协同工具', color: '#6a8fba' },
};

const LARGE_TOOL_RESULT_THRESHOLD = 30_000;
const LARGE_TOOL_RESULT_HEAD = 16_000;
const LARGE_TOOL_RESULT_TAIL = 4_000;

function formatArgs(args: string | undefined, maxLen = 120): string {
  if (!args) return '';
  try {
    const obj = JSON.parse(args);
    if (obj && typeof obj === 'object' && 'agent' in obj && 'action' in obj) {
      return `${obj.agent} · ${obj.action}`.slice(0, maxLen);
    }
    const flat = Object.entries(obj)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)}`)
      .join(', ');
    return flat.slice(0, maxLen);
  } catch {
    return args.slice(0, maxLen);
  }
}

function makeResultPreview(result: string): string {
  if (result.length <= LARGE_TOOL_RESULT_THRESHOLD) return result;
  const hidden = result.length - LARGE_TOOL_RESULT_HEAD - LARGE_TOOL_RESULT_TAIL;
  return [
    result.slice(0, LARGE_TOOL_RESULT_HEAD),
    '',
    `... 已折叠 ${hidden.toLocaleString()} 个字符 ...`,
    '',
    result.slice(-LARGE_TOOL_RESULT_TAIL),
  ].join('\n');
}

export function ToolCallCard({ toolName, toolArgs, toolResult }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showFullResult, setShowFullResult] = useState(false);
  const meta = TOOL_META[toolName] || { icon: '-', label: toolName, color: '#6c7086' };
  const hasLargeResult = Boolean(toolResult && toolResult.length > LARGE_TOOL_RESULT_THRESHOLD);
  const visibleResult = toolResult && hasLargeResult && !showFullResult
    ? makeResultPreview(toolResult)
    : toolResult;

  return (
    <div className="tool-card">
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)} style={{ borderLeftColor: meta.color }}>
        <span className="tool-card-icon">{meta.icon}</span>
        <span className="tool-card-label">{meta.label}</span>
        {toolArgs && (
          <span className="tool-card-args">{formatArgs(toolArgs)}</span>
        )}
        <span className="tool-card-toggle">{expanded ? '-' : '+'}</span>
      </div>
      {expanded && visibleResult && (
        <>
          <pre className={`tool-card-result ${hasLargeResult && !showFullResult ? 'tool-card-result-preview' : ''}`}>
            {visibleResult}
          </pre>
          {hasLargeResult && !showFullResult && (
            <button className="tool-card-expand-btn" onClick={() => setShowFullResult(true)}>
              显示完整结果
            </button>
          )}
        </>
      )}
    </div>
  );
}
