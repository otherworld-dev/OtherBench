import type { JSX } from 'react';
import type { ApprovalChoice, ApprovalRequest } from '@grunt/core/ports/tool-provider.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import { api } from '../state/api.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { AttachmentChip } from './AttachmentChip.js';
import { MarkdownBody } from './MarkdownBody.js';

function NoticeBlock({ text }: { text: string }): JSX.Element {
  return (
    <div
      role="note"
      className="my-1 flex items-start gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs text-[var(--text-muted)]"
    >
      <span aria-hidden="true">ℹ️</span>
      <span>{text}</span>
    </div>
  );
}

/**
 * A stand-in display name for an `image` Part, which -- unlike `file` --
 * carries no `filename` field (see `Part`'s doc in
 * packages/core/src/types/messages.ts): just an opaque `attachmentId` and a
 * MIME type. Mirrors the same id+extension convention `convert.ts`'s
 * `imagePlaceholder` uses for the model-facing placeholder, so the chip
 * shown here and the text a vision-less model actually saw agree with each
 * other. A real upload's OWN chip (rendered live in the Composer, before
 * sending) shows the true filename instead -- this fallback is only reached
 * once a message has round-tripped through the store, which persists no
 * filename for an `image` part.
 */
function imageDisplayName(attachmentId: string, mime: string): string {
  const subtype = mime.split('/')[1] ?? '';
  const ext = (subtype.split('+')[0] ?? '').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  return `${attachmentId}.${ext}`;
}

function AttachmentPartChip({ part }: { part: Extract<Part, { type: 'image' | 'file' }> }): JSX.Element {
  const filename = part.type === 'file' ? part.filename : imageDisplayName(part.attachmentId, part.mime);
  const previewUrl = api.attachments.previewable(part.mime) ? api.attachments.contentUrl(part.attachmentId) : undefined;
  return <AttachmentChip filename={filename} mime={part.mime} previewUrl={previewUrl} />;
}

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
    case 'notice':
      return <NoticeBlock key={key} text={part.text} />;
    case 'image':
    case 'file':
      return (
        <div key={key} className="my-1">
          <AttachmentPartChip part={part} />
        </div>
      );
    default:
      return null;
  }
}

type ToolPart = Extract<Part, { type: 'tool-call' | 'tool-result' }>;

/** "Used 14 tools: Glob ×4, Read ×6, Bash" -- names in first-seen order, ×1 omitted. Counts calls; a (shouldn't-happen) run of results alone counts those instead. */
function toolGroupSummary(run: ToolPart[]): string {
  const calls = run.filter((p) => p.type === 'tool-call');
  const counted = calls.length > 0 ? calls : run;
  const counts = new Map<string, number>();
  for (const p of counted) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const breakdown = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
  const failed = run.some((p) => p.type === 'tool-result' && p.isError);
  return `${failed ? '⚠ ' : ''}Used ${counted.length} ${counted.length === 1 ? 'tool' : 'tools'}: ${breakdown}`;
}

/** A collapsed-by-default block for one run of consecutive tool calls/results; expanding shows the unchanged per-part blocks. */
function ToolGroup({ run }: { run: ToolPart[] }): JSX.Element {
  return (
    <details className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <summary className="cursor-pointer font-medium text-[var(--text-muted)] select-none">{toolGroupSummary(run)}</summary>
      <div className="mt-1">{run.map((p, i) => renderPart(p, i))}</div>
    </details>
  );
}

/** Renders a message's parts, folding each run of consecutive tool-call/tool-result parts into one `ToolGroup`. */
function renderParts(parts: Part[]): JSX.Element[] {
  const out: JSX.Element[] = [];
  let run: ToolPart[] = [];
  const flush = (key: number): void => {
    if (run.length > 0) out.push(<ToolGroup key={`tools-${key}`} run={run} />);
    run = [];
  };
  parts.forEach((p, i) => {
    if (p.type === 'tool-call' || p.type === 'tool-result') {
      run.push(p);
      return;
    }
    flush(i);
    const el = renderPart(p, i);
    if (el) out.push(el);
  });
  flush(parts.length);
  return out;
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
  /** Tool calls this message has made that are still waiting on a human decision (task 26). Rendered inline, right where the eventual tool-result would appear. */
  pendingApprovals?: ApprovalRequest[];
  /** Required whenever `pendingApprovals` is non-empty; omitted (with an empty array) everywhere a message can never have one, e.g. read-only historical views. */
  onResolveApproval?: (requestId: string, choice: ApprovalChoice) => Promise<void>;
}

/**
 * Renders one message. This is also the renderer VariantCard (VariantTabs.tsx)
 * wraps for a single tab/split-column's body -- task 27's design calls for
 * the tab strip and the split view to be "a container swap, not a second
 * implementation", so this component stays deliberately unaware of whether
 * it's being shown standalone, inside a tab, or inside a split column.
 */
export function Message({
  message,
  otherVariantsCount = 0,
  onReopenVariants,
  pendingApprovals = [],
  onResolveApproval,
}: MessageProps): JSX.Element {
  const isUser = message.role === 'user';
  const label = isUser ? 'You' : (message.producedBy?.profileName ?? 'Assistant');
  // Assistant messages already render image/file parts inline, in order,
  // via `renderPart` below -- this is only for the user side, which renders
  // its text as one plain (non-markdown) block rather than part-by-part
  // (see the "renders user messages as plain text" test), so its
  // attachments need their own pass here instead.
  const userAttachmentParts = isUser
    ? message.parts.filter((p): p is Extract<Part, { type: 'image' | 'file' }> => p.type === 'image' || p.type === 'file')
    : [];

  return (
    <article id={`msg-${message.id}`} data-role={message.role} data-status={message.status} className="space-y-1">
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
        {isUser ? message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : renderParts(message.parts)}
        {message.status === 'streaming' && <span className="streaming-caret" aria-label="streaming" />}
      </div>

      {userAttachmentParts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {userAttachmentParts.map((p, i) => (
            <AttachmentPartChip key={i} part={p} />
          ))}
        </div>
      )}

      {pendingApprovals.length > 0 && onResolveApproval && (
        <div className="space-y-1">
          {pendingApprovals.map((request) => (
            <ApprovalPrompt key={request.id} request={request} onResolve={onResolveApproval} />
          ))}
        </div>
      )}

      {message.status === 'error' && message.error && (
        <p className="text-xs text-[var(--danger)]">{message.error.message}</p>
      )}
    </article>
  );
}
