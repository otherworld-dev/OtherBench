import type { JSX, ReactNode } from 'react';
import type { Part, SubagentStatus } from '@grunt/core/types/messages.js';

type SubagentPart = Extract<Part, { type: 'subagent' }>;

const STATUS_TEXT: Record<SubagentStatus, string> = {
  queued: 'waiting to start',
  running: 'working…',
  complete: 'done',
  error: 'failed',
  cancelled: 'stopped',
};

/** A card still queued or running on a reply that is no longer streaming was stopped (or Grunt went away). */
export function subagentDisplayStatus(status: SubagentStatus, replyStreaming: boolean): SubagentStatus {
  return !replyStreaming && (status === 'queued' || status === 'running') ? 'cancelled' : status;
}

export interface SubagentCardProps {
  part: SubagentPart;
  /** Whether the reply it belongs to is still streaming. */
  replyStreaming: boolean;
  /** Whether one of the reply's pending approval cards is this sub-agent's. */
  awaitingApproval: boolean;
  /** The sub-agent's own parts, rendered by the caller (Message's renderParts). */
  children: ReactNode;
}

/**
 * One sub-agent of a reply (spec 2026-10-12-api-subagents-design): closed by
 * default, its label, profile, model and status on one line, and its prompt
 * and transcript inside. Everything the sub-agent's model wrote renders as
 * React text, never as HTML.
 */
export function SubagentCard({ part, replyStreaming, awaitingApproval, children }: SubagentCardProps): JSX.Element {
  const status = subagentDisplayStatus(part.status, replyStreaming);
  const waiting = awaitingApproval && status === 'running';
  const usage = part.usage;
  // A stored card is only as well-formed as the row it came from: show tokens only when both counts are there.
  const tokens =
    usage && typeof usage.tokensIn === 'number' && typeof usage.tokensOut === 'number' && (status === 'complete' || status === 'error')
      ? `${usage.tokensIn.toLocaleString()} in · ${usage.tokensOut.toLocaleString()} out`
      : null;
  return (
    <details data-testid="subagent-card" data-status={status} className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <summary className="cursor-pointer select-none">
        <span className="font-medium text-[var(--text)]">◇ {part.label}</span>
        <span className="ml-2 text-[var(--text-muted)]">{part.profileName}</span>
        <span className="ml-2 font-mono text-[var(--text-faint)]">{part.modelId}</span>
        <span className={`ml-2 ${status === 'error' ? 'text-[var(--danger)]' : waiting ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]'}`}>
          {waiting ? 'needs your approval' : STATUS_TEXT[status]}
        </span>
        {tokens && <span className="ml-2 text-[var(--text-faint)]">{tokens}</span>}
      </summary>
      <div className="mt-1 space-y-1">
        <p className="whitespace-pre-wrap rounded bg-[var(--bg)] px-2 py-1 text-[var(--text-muted)]">{part.prompt}</p>
        <div className="text-sm">{children}</div>
        {part.error && <p className="text-[var(--danger)]">{part.error}</p>}
      </div>
    </details>
  );
}
