import type { JSX } from 'react';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import { MarkdownBody } from './MarkdownBody.js';

function ReasoningBlock({ text }: { text: string }): JSX.Element {
  return (
    <details className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <summary className="cursor-pointer font-medium text-[var(--text-muted)] select-none">Reasoning</summary>
      <p className="mt-1 whitespace-pre-wrap text-[var(--text-muted)]">{text}</p>
    </details>
  );
}

function ToolCallBlock({ name, args }: { name: string; args: unknown }): JSX.Element {
  return (
    <div className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <span className="font-medium">🔧 {name}</span>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(args, null, 2)}</pre>
    </div>
  );
}

function ToolResultBlock({ name, result, isError }: { name: string; result: unknown; isError: boolean }): JSX.Element {
  return (
    <div className={`my-1 rounded border px-2 py-1 text-xs ${isError ? 'border-[var(--danger)]' : 'border-[var(--border)]'} bg-[var(--bg-sunken)]`}>
      <span className="font-medium">{isError ? '⚠️' : '↳'} {name} result</span>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}

function renderPart(part: Part, key: number): JSX.Element | null {
  switch (part.type) {
    case 'text':
      return <MarkdownBody key={key} text={part.text} />;
    case 'reasoning':
      return <ReasoningBlock key={key} text={part.text} />;
    case 'tool-call':
      return <ToolCallBlock key={key} name={part.name} args={part.args} />;
    case 'tool-result':
      return <ToolResultBlock key={key} name={part.name} result={part.result} isError={part.isError} />;
    case 'image':
    case 'file':
      return (
        <div key={key} className="my-1 text-xs text-[var(--text-muted)] italic">
          [{part.type}: {part.mime}]
        </div>
      );
    default:
      return null;
  }
}

export interface MessageProps {
  message: CanonMessage;
  /**
   * > 0 when this message is the KEPT variant of a resolved compare turn
   * that still has other, non-selected siblings sitting around (never
   * deleted -- they cost money and represent work, task 27 design). Renders
   * a "⤺ N other variants" chip that reopens the tab strip in place of this
   * message; omit (or 0) for an ordinary message with no siblings.
   */
  otherVariantsCount?: number;
  onReopenVariants?: () => void;
}

/**
 * Renders one message. This is also the renderer VariantCard (VariantTabs.tsx)
 * wraps for a single tab/split-column's body -- task 27's design calls for
 * the tab strip and the split view to be "a container swap, not a second
 * implementation", so this component stays deliberately unaware of whether
 * it's being shown standalone, inside a tab, or inside a split column.
 */
export function Message({ message, otherVariantsCount = 0, onReopenVariants }: MessageProps): JSX.Element {
  const isUser = message.role === 'user';
  const label = isUser ? 'You' : (message.producedBy?.profileName ?? 'Assistant');

  return (
    <article data-role={message.role} data-status={message.status} className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <span className="font-medium text-[var(--text)]">{label}</span>
        {!isUser && message.producedBy && <span>{message.producedBy.modelId}</span>}
        {message.status === 'error' && <span className="text-[var(--danger)]">error</span>}
        {message.status === 'cancelled' && <span>stopped</span>}
        {otherVariantsCount > 0 && (
          <button
            type="button"
            data-testid="reopen-variants-chip"
            onClick={onReopenVariants}
            className="ml-auto rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
          >
            ⤺ {otherVariantsCount} other variant{otherVariantsCount === 1 ? '' : 's'}
          </button>
        )}
      </div>

      <div className={isUser ? 'whitespace-pre-wrap text-sm' : ''}>
        {isUser ? message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : message.parts.map((p, i) => renderPart(p, i))}
        {message.status === 'streaming' && <span className="streaming-caret" aria-label="streaming" />}
      </div>

      {message.status === 'error' && message.error && (
        <p className="text-xs text-[var(--danger)]">{message.error.message}</p>
      )}
    </article>
  );
}
