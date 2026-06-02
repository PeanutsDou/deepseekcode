import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { MermaidBlock } from './MermaidBlock';

interface Props {
  text: string;
  markdown?: boolean;
  collapsedChars?: number;
  className?: string;
}

const DEFAULT_COLLAPSED_CHARS = 1600;

const markdownComponents = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const lang = match?.[1];
    const code = String(children).replace(/\n$/, '');
    if (lang === 'mermaid') return <MermaidBlock code={code} />;
    if (className) {
      return <pre><code className={className} {...props}>{children}</code></pre>;
    }
    return <code {...props}>{children}</code>;
  },
};

function makePreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(600, Math.floor(maxChars * 0.75));
  const tail = Math.max(240, maxChars - head);
  const hidden = text.length - head - tail;
  return [
    text.slice(0, head),
    '',
    `... 已折叠 ${hidden.toLocaleString()} 个字符 ...`,
    '',
    text.slice(-tail),
  ].join('\n');
}

export function ExpandableText({ text, markdown = false, collapsedChars = DEFAULT_COLLAPSED_CHARS, className }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > collapsedChars;
  const visible = isLong && !expanded ? makePreview(text, collapsedChars) : text;

  return (
    <div className={`expandable-text ${className || ''}`}>
      <div className={isLong && !expanded ? 'expandable-text-preview' : undefined}>
        {markdown ? (
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
            {visible}
          </ReactMarkdown>
        ) : (
          <pre>{visible}</pre>
        )}
      </div>
      {isLong && (
        <button type="button" className="expandable-text-toggle" onClick={() => setExpanded(v => !v)}>
          {expanded ? '收起' : '查看完整内容'}
        </button>
      )}
    </div>
  );
}
