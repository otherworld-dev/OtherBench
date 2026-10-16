import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { Part, SubagentStatus } from '@otherbench/core/types/messages.js';

type SubagentPart = Extract<Part, { type: 'subagent' }>;

const STATUS_TEXT: Record<SubagentStatus, string> = {
  queued: 'waiting to start',
  running: 'working…',
  complete: 'done',
  error: 'failed',
  cancelled: 'stopped',
};

/** A card still queued or running on a reply that is no longer streaming was stopped (or OtherBench went away). */
export function subagentDisplayStatus(status: SubagentStatus, replyStreaming: boolean): SubagentStatus {
  return !replyStreaming && (status === 'queued' || status === 'running') ? 'cancelled' : status;
}

/** A running time for a person: "42s", "1m 12s", "1h 3m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The argument keys that best say what a tool call is about, in order. */
const GIST_KEYS = ['pattern', 'file_path', 'path', 'notebook_path', 'command', 'url', 'query', 'description', 'prompt'];
const GIST_MAX = 48;

/** A tool call in a few words: its name and the first telling argument, e.g. `Grep "profileId"`. */
export function toolGist(name: string, args: unknown): string {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const value = GIST_KEYS.map((k) => a[k]).find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (!value) return name;
  const line = value.trim().split('\n')[0]!;
  return `${name} "${line.length > GIST_MAX ? `${line.slice(0, GIST_MAX - 1)}…` : line}"`;
}

/** The time now, every second while `live`: a running card's clock. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
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
 * One sub-agent of a reply (spec 2026-10-12-api-subagents-design), or a
 * helper Claude Code started: closed by default, with its label, profile (a
 * helper's type), model, status, how many tools it has used and how long it
 * has run on one line, and while it works the tool it used last. Its prompt
 * and transcript are inside. Everything the sub-agent's model wrote renders
 * as React text, never as HTML.
 */
export function SubagentCard({ part, replyStreaming, awaitingApproval, children }: SubagentCardProps): JSX.Element {
  const status = subagentDisplayStatus(part.status, replyStreaming);
  const waiting = awaitingApproval && status === 'running';
  const working = status === 'running' || status === 'queued';
  const now = useNow(working && typeof part.startedAt === 'number');
  const calls = (part.parts ?? []).filter((p): p is Extract<Part, { type: 'tool-call' }> => p.type === 'tool-call');
  const lastCall = calls.at(-1);
  const ended = typeof part.finishedAt === 'number' ? part.finishedAt : working ? now : null;
  const elapsed = typeof part.startedAt === 'number' && ended !== null ? formatDuration(ended - part.startedAt) : null;
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
        {calls.length > 0 && (
          <span data-testid="subagent-tools" className="ml-2 font-mono text-[var(--text-faint)]">
            {calls.length} {calls.length === 1 ? 'tool' : 'tools'}
          </span>
        )}
        {elapsed && (
          <span data-testid="subagent-elapsed" className="ml-2 font-mono text-[var(--text-faint)]">
            {elapsed}
          </span>
        )}
        {tokens && <span className="ml-2 text-[var(--text-faint)]">{tokens}</span>}
        {working && lastCall && (
          <span data-testid="subagent-last-tool" className="ml-4 block truncate font-mono text-[var(--text-faint)]">
            last: {toolGist(lastCall.name, lastCall.args)}
          </span>
        )}
      </summary>
      <div className="mt-1 space-y-1">
        <p className="whitespace-pre-wrap rounded bg-[var(--bg)] px-2 py-1 text-[var(--text-muted)]">{part.prompt}</p>
        <div className="text-sm">{children}</div>
        {part.error && <p className="text-[var(--danger)]">{part.error}</p>}
      </div>
    </details>
  );
}
