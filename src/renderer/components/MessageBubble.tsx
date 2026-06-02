import React, { memo, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { ChatEntry } from '../stores/chat-store';
import { useChatStore } from '../stores/chat-store';
import { DiffPreview } from './DiffPreview';
import { MermaidBlock } from './MermaidBlock';
import { ToolCallCard } from './ToolCallCard';
import { ToolSummaryCard } from './ToolSummaryCard';
import { ArtifactPreviewButton } from './ArtifactPreview';
import { ExpandableText } from './ExpandableText';
import { inferImageMimeType } from '../utils/attachments';

interface Props {
  entry: ChatEntry;
}

const LONG_MESSAGE_THRESHOLD = 60_000;
const LONG_MESSAGE_HEAD = 24_000;
const LONG_MESSAGE_TAIL = 6_000;

function makeTextPreview(text: string): string {
  if (text.length <= LONG_MESSAGE_THRESHOLD) return text;
  const hidden = text.length - LONG_MESSAGE_HEAD - LONG_MESSAGE_TAIL;
  return [
    text.slice(0, LONG_MESSAGE_HEAD),
    '',
    `... 已折叠 ${hidden.toLocaleString()} 个字符 ...`,
    '',
    text.slice(-LONG_MESSAGE_TAIL),
  ].join('\n');
}

const markdownComponents = {
  code({ className, children, ...props }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const lang = match?.[1];
    const code = String(children).replace(/\n$/, '');

    if (lang === 'mermaid') {
      return <MermaidBlock code={code} />;
    }

    if (className) {
      return (
        <pre><code className={className} {...props}>
          {children}
        </code></pre>
      );
    }

    return <code {...props}>{children}</code>;
  },
};

export const MessageBubble = memo(function MessageBubble({ entry }: Props) {
  const [copied, setCopied] = useState(false);
  const [showFullContent, setShowFullContent] = useState(false);
  const isLongContent = entry.content.length > LONG_MESSAGE_THRESHOLD;
  const visibleContent = isLongContent && !showFullContent ? makeTextPreview(entry.content) : entry.content;
  const isCollabSystem = entry.role === 'system' && entry.id.startsWith('collab_');
  const collabArtifact = entry.collabEvent?.type === 'artifact_written' && entry.collabEvent.taskId && entry.collabEvent.artifactId
    ? {
      taskId: entry.collabEvent.taskId,
      artifact: {
        id: entry.collabEvent.artifactId,
        type: String(entry.collabEvent.artifactType || 'artifact'),
        path: entry.collabEvent.artifactPath || '',
        createdAt: entry.collabEvent.createdAt || entry.timestamp,
      },
    }
    : null;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(entry.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* */ }
  }, [entry.content]);

  const handleRegenerate = useCallback(() => {
    const state = useChatStore.getState();
    const sid = state.activeId || 'default';
    const session = state.sessions[sid];
    const allEntries = session?.entries || [];
    const myIdx = allEntries.findIndex(e => e.id === entry.id);
    if (myIdx < 0) return;
    let userMsg = '';
    let userAttachments: { type: string; data: string; mimeType: string }[] | undefined;
    for (let i = myIdx - 1; i >= 0; i--) {
      if (allEntries[i].role === 'user') {
        userMsg = allEntries[i].content;
        userAttachments = allEntries[i].attachments?.map(a => ({
          type: a.type,
          data: a.data,
          mimeType: a.mimeType || (a.type === 'image' ? inferImageMimeType(a.data) : 'text/plain'),
        }));
        break;
      }
    }
    if (userMsg && window.electronAPI) {
      const previousEntries = allEntries;
      state.trimEntriesFrom(sid, myIdx);
      state.setStreamingTo(sid, true);
      void (async () => {
        if (session?.modelId) {
          state.setSessionModelTo(sid, session.modelId);
          await window.electronAPI.setSessionModel?.(sid, session.modelId).catch(() => {});
        }
        await window.electronAPI.regenerate(sid, userMsg, userAttachments);
      })().catch(err => {
        const next = useChatStore.getState();
        next.loadEntries(sid, previousEntries, session?.modelId);
        next.setErrorTo(sid, err instanceof Error ? err.message : String(err));
      });
    }
  }, [entry.id]);

  const actionButtons = (
    <div className="message-actions">
      <button className="msg-action-btn" onClick={handleCopy} title="复制">
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3,8 6,11 13,4" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="5" width="9" height="10" rx="1.5" />
            <path d="M2 11V3a1 1 0 011-1h7" />
          </svg>
        )}
      </button>
      {entry.role === 'assistant' && (
        <button className="msg-action-btn" onClick={handleRegenerate} title="重新生成">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 8a6 6 0 0111.3-3.3" />
            <polyline points="14,2 14,6 10,6" />
            <path d="M14 8a6 6 0 01-11.3 3.3" />
            <polyline points="2,14 2,10 6,10" />
          </svg>
        </button>
      )}
    </div>
  );

  if (entry.role === 'system' && entry.toolSummary) {
    return (
      <div className="message message-tool">
        <ToolSummaryCard
          summary={entry.content}
          tools={entry.toolSummary}
          expanded={entry.toolSummaryExpanded}
          onToggle={(expanded) => {
            const state = useChatStore.getState();
            const sid = state.activeId || 'default';
            state.setEntryToolSummaryExpanded(sid, entry.id, expanded);
          }}
        />
      </div>
    );
  }

  if (entry.role === 'system') {
    return (
      <div className={`message message-system ${isCollabSystem ? 'message-collab-system' : ''}`}>
        <div className="message-content">
          {collabArtifact ? (
            <div className="collab-artifact-message">
              <span>{entry.content}</span>
              <ArtifactPreviewButton taskId={collabArtifact.taskId} artifact={collabArtifact.artifact} />
            </div>
          ) : isCollabSystem ? (
            <ExpandableText text={entry.content} markdown collapsedChars={1800} className="collab-message-text" />
          ) : (
            entry.content
          )}
        </div>
      </div>
    );
  }

  if (entry.role === 'tool') {
    let diffData: { status: string; file: string; line: number; old: string; new: string } | null = null;
    if (entry.toolName === 'edit_file' && entry.toolResult) {
      try {
        const parsed = JSON.parse(entry.toolResult);
        if (parsed.status === 'modified') diffData = parsed;
      } catch { /* not JSON */ }
    }

    return (
      <div className="message message-tool">
        <ToolCallCard
          toolName={entry.toolName || 'unknown'}
          toolArgs={entry.toolArgs}
          toolResult={diffData ? undefined : entry.toolResult}
        />
        {diffData && <DiffPreview data={diffData} />}
      </div>
    );
  }

  return (
    <div className={`msg-outer msg-outer-${entry.role}`}>
      <div className={`message message-${entry.role}`}>
        {entry.attachments && entry.attachments.length > 0 && (
          <div className="message-attachments">
            {entry.attachments.map((att, i) => (
              <img key={i} src={att.data} alt={att.name} className="message-attachment-img" onClick={() => window.dispatchEvent(new CustomEvent('open-image-viewer', { detail: att.data }))} />
            ))}
          </div>
        )}
        <div className="message-content">
          {isLongContent && !showFullContent ? (
            <>
              <pre className="message-text-preview">{visibleContent}</pre>
              <button className="message-expand-btn" onClick={() => setShowFullContent(true)}>
                显示完整消息
              </button>
            </>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              components={markdownComponents}
            >
              {visibleContent}
            </ReactMarkdown>
          )}
        </div>
      </div>
      {actionButtons}
    </div>
  );
});
