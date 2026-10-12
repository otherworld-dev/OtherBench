import { useState, type JSX } from 'react';
import type { ApprovalChoice, ApprovalRequest } from '@grunt/core/ports/tool-provider.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import { SUBAGENT_TOOL_NAME } from '@grunt/core/domain/parts.js';
import { api } from '../state/api.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { AttachmentChip } from './AttachmentChip.js';
import { MarkdownBody } from './MarkdownBody.js';
import { SubagentCard } from './SubagentCard.js';
import { artifactOutcomeOf, isArtifactTool, toolPath } from '../viewer/paths.js';
import { useViewer } from '../viewer/ViewerContext.js';

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
  const viewer = useViewer();
  const path = viewer ? toolPath(name, args) : null;
  return (
    <div className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <span className="font-medium">🔧 {name}</span>
      {path && viewer && (
        <button type="button" aria-label={`Open ${path}`} title="Open in the viewer" onClick={() => viewer.openPath(path)} className="ml-2 underline decoration-dotted">
          Open
        </button>
      )}
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

const VERB = { create: 'Created', update: 'Updated to', rewrite: 'Rewrote as' } as const;

/** An artifact call's card (Deck #896): what it made, opening that version in the chat's viewer. */
function ArtifactCard({ result }: { result: unknown }): JSX.Element | null {
  const viewer = useViewer();
  const info = artifactOutcomeOf(result);
  if (!info) return null;
  return (
    <button
      type="button"
      onClick={() => viewer?.openArtifact({ artifactId: info.artifactId, title: info.title, versionId: info.versionId })}
      className="my-1 flex w-full items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-left text-sm hover:bg-[var(--bg-sunken)]"
    >
      <span aria-hidden="true">◧</span>
      <span className="min-w-0 flex-1 truncate font-medium">{info.title}</span>
      <span className="text-xs text-[var(--text-muted)]">{`${info.kind} · ${VERB[info.command]} v${info.number}`}</span>
    </button>
  );
}

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

/** What `renderParts` needs to know about the reply around the parts it renders. */
interface RenderContext {
  /** The reply's approval cards still waiting, to mark the sub-agent that raised one. */
  pendingApprovals: ApprovalRequest[];
  replyStreaming: boolean;
}

const NO_CONTEXT: RenderContext = { pendingApprovals: [], replyStreaming: false };

/**
 * Renders a message's parts, folding each run of consecutive tool-call/tool-result parts into one `ToolGroup`.
 * An artifact call that made a version (Deck #896) is a card instead, outside the fold; one still running,
 * failed or only viewing folds with the rest, so its error stays visible.
 * A sub-agent is a card where its part sits, with its own parts rendered inside.
 */
function renderParts(parts: Part[], ctx: RenderContext = NO_CONTEXT): JSX.Element[] {
  const out: JSX.Element[] = [];
  let run: ToolPart[] = [];
  let runStart = 0;
  // Keyed by the run's FIRST part so the key (and the user's open/closed
  // state on the <details>) stays stable while more tool parts stream in.
  // Cards made while a run of tools is open wait for it, so parallel calls stay in one group.
  let cards: JSX.Element[] = [];
  const flush = (): void => {
    if (run.length > 0) out.push(<ToolGroup key={`tools-${runStart}`} run={run} />);
    run = [];
    out.push(...cards);
    cards = [];
  };
  const carded = new Set(parts.flatMap((p) => (p.type === 'tool-result' && isArtifactTool(p.name) && artifactOutcomeOf(p.result) ? [p.id] : [])));
  // A sub-agent shows as its card; the parent's own subagent call and result
  // for it are hidden. A subagent call with no card (refused before it
  // started) stays in the tool group, so its error shows.
  const subagentCards = new Set(parts.flatMap((p) => (p.type === 'subagent' ? [p.callId] : [])));
  parts.forEach((p, i) => {
    if ((p.type === 'tool-call' || p.type === 'tool-result') && p.name === SUBAGENT_TOOL_NAME && subagentCards.has(p.id)) return;
    if (p.type === 'subagent') {
      flush();
      out.push(
        <SubagentCard
          key={`subagent-${p.callId}`}
          part={p}
          replyStreaming={ctx.replyStreaming}
          awaitingApproval={ctx.pendingApprovals.some((r) => r.subagent?.callId === p.callId)}
        >
          {renderParts(p.parts ?? [], ctx)}
        </SubagentCard>
      );
      return;
    }
    if (p.type === 'tool-call' || p.type === 'tool-result') {
      if (carded.has(p.id)) {
        // A carded call shows as its result's card.
        if (p.type === 'tool-result') (run.length > 0 ? cards : out).push(<ArtifactCard key={i} result={p.result} />);
        return;
      }
      if (run.length === 0) runStart = i;
      run.push(p);
      return;
    }
    flush();
    const el = renderPart(p, i);
    if (el) out.push(el);
  });
  flush();
  return out;
}

/** Position within a set of sibling messages that aren't a compare turn: regenerated replies or edited prompts. */
export interface BranchInfo {
  /** Zero-based position of this message among its siblings. */
  index: number;
  total: number;
  /** -1 for the previous sibling, 1 for the next. */
  onSelect: (delta: -1 | 1) => void;
  /** Both arrows inert, e.g. while a reply streams (a switch would move the head under it). */
  disabled?: boolean;
}

/** The compact `‹ 2 / 3 ›` control. Quiet by design: it only appears when there is something to switch to. */
function BranchSwitcher({ branch }: { branch: BranchInfo }): JSX.Element {
  const arrow =
    'rounded px-1 leading-none hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <span
      data-testid="branch-switcher"
      role="group"
      aria-label={`Branch ${branch.index + 1} of ${branch.total}`}
      className="inline-flex items-center gap-0.5 text-xs text-[var(--text-muted)]"
    >
      <button type="button" aria-label="Previous branch" disabled={branch.disabled || branch.index <= 0} onClick={() => branch.onSelect(-1)} className={arrow}>
        ‹
      </button>
      <span className="tabular-nums" aria-hidden="true">
        {branch.index + 1} / {branch.total}
      </span>
      <button type="button" aria-label="Next branch" disabled={branch.disabled || branch.index >= branch.total - 1} onClick={() => branch.onSelect(1)} className={arrow}>
        ›
      </button>
    </span>
  );
}

type AttachmentPart = Extract<Part, { type: 'image' | 'file' }>;

/**
 * Inline editor for a user message: its text in a textarea, plus its
 * attachment chips (removable -- only from this edit; the original message
 * keeps them). Saving hands back the new parts; the caller sends them as a
 * sibling message.
 */
function MessageEditor({
  message,
  editing,
}: {
  message: CanonMessage;
  editing: NonNullable<MessageProps['editing']>;
}): JSX.Element {
  const [text, setText] = useState(() =>
    message.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  );
  const [attachments, setAttachments] = useState<AttachmentPart[]>(() =>
    message.parts.filter((p): p is AttachmentPart => p.type === 'image' || p.type === 'file')
  );
  const trimmed = text.trim();
  const canSave = !editing.busy && (trimmed.length > 0 || attachments.length > 0);

  function save(): void {
    if (!canSave) return;
    editing.onSave([...(trimmed.length > 0 ? [{ type: 'text', text: trimmed } as Part] : []), ...attachments]);
  }

  return (
    <div className="space-y-2">
      <textarea
        autoFocus
        aria-label="Edit message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') editing.onCancel();
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        }}
        rows={Math.min(12, Math.max(2, text.split('\n').length))}
        className="w-full resize-y rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
      />
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((p, i) => (
            <AttachmentChip
              key={p.attachmentId}
              filename={p.type === 'file' ? p.filename : imageDisplayName(p.attachmentId, p.mime)}
              mime={p.mime}
              previewUrl={api.attachments.previewable(p.mime) ? api.attachments.contentUrl(p.attachmentId) : undefined}
              onRemove={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="btn btn-primary px-3 py-1"
        >
          Save and send
        </button>
        <button
          type="button"
          onClick={editing.onCancel}
          className="btn px-3 py-1"
        >
          Cancel
        </button>
        <span className="text-xs text-[var(--text-muted)]">Sends as a new branch; the original stays.</span>
      </div>
      <div data-testid="edit-profile-note" className="text-xs text-[var(--text-muted)]">
        {editing.profileName ? `Answered by ${editing.profileName}.` : 'Answered by the chat profile.'}
        {editing.compareNote && ' This was a compare prompt; the edit goes to one profile only.'}
      </div>
    </div>
  );
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
  /** Shows the `‹ 2 / 3 ›` switcher: this message has non-compare siblings (a regenerated reply, an edited prompt). */
  branch?: BranchInfo;
  /** Offers "Regenerate" (assistant messages). Omit where it doesn't apply, e.g. a compare turn's variants. */
  onRegenerate?: () => void;
  /** Offers "Edit" (user messages). */
  onEdit?: () => void;
  /** Draws the message in a bordered box (the thread does; compare cards have their own). */
  framed?: boolean;
  /** Greys out Regenerate/Edit, e.g. while a reply in this chat is streaming. */
  actionsDisabled?: boolean;
  /** Replaces a user message's body with the inline editor. */
  editing?: {
    onSave: (parts: Part[]) => void;
    onCancel: () => void;
    /** Save is inert (a send is in flight, or a reply is streaming). */
    busy?: boolean;
    /** The profile that will answer the edit. */
    profileName?: string;
    /** The original was a compare turn's prompt: the edit goes to ONE profile. */
    compareNote?: boolean;
  };
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
  branch,
  onRegenerate,
  onEdit,
  actionsDisabled = false,
  editing,
  framed = false,
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
    <article
      id={`msg-${message.id}`}
      data-role={message.role}
      data-status={message.status}
      className={`group space-y-1 ${framed ? 'rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2' : ''}`}
    >
      <div data-message-header="" className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <span className={`label-caps ${isUser ? 'text-[var(--text-muted)]' : 'text-[var(--accent)]'}`}>{label}</span>
        {!isUser && message.producedBy && <span className="font-mono text-[var(--text-faint)]">{message.producedBy.modelId}</span>}
        {message.status === 'error' && <span className="text-[var(--danger)]">error</span>}
        {message.status === 'cancelled' && <span>stopped</span>}
        {branch && branch.total > 1 && <BranchSwitcher branch={branch} />}
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
        {/* On the label line rather than a line of their own; shown on hover or keyboard focus (opacity only, so still clickable). */}
        {!editing && (onRegenerate || onEdit) && (
          <span
            className={`${otherVariantsCount > 0 ? '' : 'ml-auto'} flex gap-3 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100`}
          >
            {onRegenerate && (
              <button type="button" onClick={onRegenerate} disabled={actionsDisabled} className="label-caps hover:text-[var(--text)] focus-visible:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-[var(--text-muted)]">
                Regenerate
              </button>
            )}
            {onEdit && (
              <button type="button" onClick={onEdit} disabled={actionsDisabled} className="label-caps hover:text-[var(--text)] focus-visible:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-[var(--text-muted)]">
                Edit
              </button>
            )}
          </span>
        )}
      </div>

      {isUser && editing ? (
        <MessageEditor message={message} editing={editing} />
      ) : (
      <div className={isUser ? 'whitespace-pre-wrap text-sm' : ''}>
        {isUser ? message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : renderParts(message.parts, { pendingApprovals, replyStreaming: message.status === 'streaming' })}
        {message.status === 'streaming' && <span className="streaming-caret" aria-label="streaming" />}
      </div>
      )}

      {userAttachmentParts.length > 0 && !editing && (
        <div className="flex flex-wrap gap-1.5">
          {userAttachmentParts.map((p, i) => (
            <AttachmentPartChip key={i} part={p} />
          ))}
        </div>
      )}

      {/* Notices on the user side: an imported message's files the claude.ai export didn't include, say. */}
      {isUser && !editing && message.parts.map((p, i) => (p.type === 'notice' ? <NoticeBlock key={i} text={p.text} /> : null))}

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
