import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { AuditEntry, Chat, Grant } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';
import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';

export interface InspectorProps {
  chat: Chat | null;
  profile: Profile | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="border-b border-[var(--border)] px-4 py-3 last:border-b-0">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">{title}</h3>
      {children}
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-[var(--text-faint)]">{children}</p>;
}

function formatCost(cost: number): string {
  return cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/**
 * How often the honest-state sections below (MCP health, grants, audit)
 * re-poll -- there is no push channel for any of the three (unlike the
 * thread itself, which is SSE-driven): MCP server status changes on its own
 * timeline (health checks, reconnects) with nothing to notify this pane;
 * a grant can be created as a side effect of an approval resolved from
 * Thread.tsx, a sibling component with no direct line to this one; and the
 * audit trail grows on every gated tool call, same story. Polling is the
 * simple, honest choice here over wiring a second SSE channel or lifting
 * shared state up -- "the inspector is the honest-state surface" (task 26
 * decision #3) is about never rendering an empty state that HIDES real
 * activity, not about sub-second live-ness.
 */
const POLL_INTERVAL_MS = 4000;

/**
 * Polls `fetcher` every `POLL_INTERVAL_MS`, starting immediately and
 * restarting whenever `deps` changes (e.g. switching chats). Deliberately
 * does NOT clear `data` back to `null` between ticks of the SAME poll loop
 * -- only on a genuine restart -- so a routine re-poll updates numbers in
 * place instead of flashing back to a loading state every few seconds.
 */
function usePolled<T>(fetcher: () => Promise<T>, deps: unknown[]): { data: T | null; failed: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(null);
    setFailed(false);

    async function tick(): Promise<void> {
      try {
        const result = await fetcher();
        if (!cancelled) {
          setData(result);
          setFailed(false);
        }
      } catch (err) {
        console.error('[grunt-web] Inspector poll failed:', err);
        if (!cancelled) setFailed(true);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is the caller's own explicit restart list, not derivable from `fetcher`'s identity.
  }, deps);

  return { data, failed };
}

const MCP_STATUS_COLOR: Record<McpServerHealth['status'], string> = {
  ok: 'bg-[var(--success,#3fb950)]',
  connecting: 'bg-[var(--accent)] animate-pulse',
  error: 'bg-[var(--danger)]',
  unknown: 'bg-[var(--text-faint)]',
};

function StatusDot({ status }: { status: McpServerHealth['status'] }): JSX.Element {
  return <span data-testid="mcp-status-dot" data-status={status} className={`inline-block h-2 w-2 shrink-0 rounded-full ${MCP_STATUS_COLOR[status]}`} aria-hidden="true" />;
}

/** "MCP server health" -- every configured server (enabled or not), its live connection status, tool count, and a manual refresh action (`POST /api/mcp-servers/:id/refresh`, task 25's reconnect-with-backoff still runs on its own regardless). */
function McpHealthSection(): JSX.Element {
  const { data: servers, failed } = usePolled(() => api.mcpServers.list(), []);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());

  async function refresh(id: string): Promise<void> {
    setRefreshingIds((s) => new Set(s).add(id));
    try {
      await api.mcpServers.refresh(id);
    } catch (err) {
      console.error(`[grunt-web] failed to refresh MCP server ${id}:`, err);
    } finally {
      setRefreshingIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  if (failed) return <EmptyState>Couldn&rsquo;t load MCP server health.</EmptyState>;
  if (servers === null) return <EmptyState>Loading…</EmptyState>;
  if (servers.length === 0) return <EmptyState>No MCP servers are configured.</EmptyState>;

  return (
    <div data-testid="mcp-health" className="space-y-2">
      {servers.map((s) => (
        <div key={s.id} data-testid={`mcp-server-${s.id}`} className="flex items-center gap-2 text-sm">
          <StatusDot status={s.status} />
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
          <span className="text-xs text-[var(--text-muted)]">{s.enabled ? `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : 'disabled'}</span>
          <button
            type="button"
            aria-label={`Refresh ${s.name}`}
            disabled={refreshingIds.has(s.id)}
            onClick={() => void refresh(s.id)}
            className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs hover:bg-[var(--bg-sunken)] disabled:opacity-50"
          >
            ↻
          </button>
        </div>
      ))}
      {servers.some((s) => s.status === 'error' && s.lastError) && (
        <div className="space-y-1 pt-1">
          {servers
            .filter((s) => s.status === 'error' && s.lastError)
            .map((s) => (
              <p key={s.id} className="text-xs text-[var(--danger)]">
                {s.name}: {s.lastError}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

/** "Tool grants" -- every grant currently in effect for this chat (chat-scoped + global 'always' grants, see routes/tools.ts), each with a Revoke action that takes effect on the VERY NEXT tool call (no restart -- see PermissionBroker.decide, which reads the grant list fresh every time). */
function GrantsSection({ chatId }: { chatId: string }): JSX.Element {
  const { data: grants, failed } = usePolled(() => api.grants.list(chatId), [chatId]);
  const [revoking, setRevoking] = useState<Set<string>>(new Set());
  const [localGrants, setLocalGrants] = useState<Grant[] | null>(null);

  useEffect(() => setLocalGrants(null), [chatId]);
  const shown = localGrants ?? grants;

  async function revoke(id: string): Promise<void> {
    setRevoking((s) => new Set(s).add(id));
    try {
      await api.grants.revoke(id);
      // Optimistic removal -- the next poll would also drop it, but a
      // Revoke button that visibly does nothing for up to POLL_INTERVAL_MS
      // reads as broken, and decision #3 requires this to be verifiably
      // immediate, not eventually-consistent-looking.
      setLocalGrants((shown ?? []).filter((g) => g.id !== id));
    } catch (err) {
      console.error(`[grunt-web] failed to revoke grant ${id}:`, err);
    } finally {
      setRevoking((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  if (failed) return <EmptyState>Couldn&rsquo;t load grants for this chat.</EmptyState>;
  if (shown === null) return <EmptyState>Loading…</EmptyState>;
  if (shown.length === 0) return <EmptyState>No grants issued in this chat yet.</EmptyState>;

  return (
    <div data-testid="grants-list" className="space-y-2">
      {shown.map((g) => (
        <div key={g.id} data-testid={`grant-${g.id}`} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{g.toolName}</span>
            <span className="ml-1.5 text-xs text-[var(--text-muted)]">
              {g.scope === 'always' ? 'always' : 'this chat'}
              {g.constraint?.pathPrefix ? ` · ${g.constraint.pathPrefix}` : ''}
              {g.constraint?.commandExact ? ` · ${g.constraint.commandExact}` : ''}
              {g.constraint?.commandPrefix ? ` · ${g.constraint.commandPrefix} (any arguments)` : ''}
            </span>
          </span>
          <button
            type="button"
            aria-label={`Revoke grant for ${g.toolName}`}
            disabled={revoking.has(g.id)}
            onClick={() => void revoke(g.id)}
            className="rounded border border-[var(--danger)] px-1.5 py-0.5 text-xs text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white disabled:opacity-50"
          >
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}

function formatAuditTime(createdAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return new Date(createdAt).toLocaleTimeString();
}

/** "Audit trail" -- every gated tool call in this chat: tool, how it was authorised, a short result summary (never raw output/content -- redaction happens server-side, see GruntToolProvider), and duration. Newest first. */
function AuditSection({ chatId }: { chatId: string }): JSX.Element {
  const { data: entries, failed } = usePolled(() => api.audit.list(chatId), [chatId]);

  if (failed) return <EmptyState>Couldn&rsquo;t load the audit trail for this chat.</EmptyState>;
  if (entries === null) return <EmptyState>Loading…</EmptyState>;
  if (entries.length === 0) return <EmptyState>No tool calls recorded in this chat yet.</EmptyState>;

  const sorted: AuditEntry[] = [...entries].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <ul data-testid="audit-trail" className="space-y-2">
      {sorted.map((entry) => (
        <li key={entry.id} data-testid={`audit-${entry.id}`} className="text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{entry.toolName}</span>
            <span className="text-xs text-[var(--text-muted)]">{formatAuditTime(entry.createdAt)}</span>
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            {entry.resultSummary} · {entry.grantedBy} · {entry.durationMs}ms
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The "Running session spend" section's body -- fetches task 28's usage
 * rollup scoped to this one chat (`GET /api/usage?chatId=`). Refetches
 * whenever the chat changes OR whenever any message in this chat reaches a
 * terminal status (complete/error/cancelled) -- a usage row is written
 * server-side right after that transition (TurnRunner.runVariant, see
 * turn.ts), so re-running the rollup then is what keeps this section
 * "running" rather than a one-shot snapshot frozen at the moment the chat
 * was opened. `statusSignal` (id:status pairs, chat-scoped) is a cheap,
 * order-independent way to depend on "did any status in this chat change"
 * without re-fetching on every streamed token.
 *
 * Kept as its own component (rather than inlined in `Inspector`) so its
 * data fetch/store subscription is scoped to `chatId` alone, not every prop
 * `Inspector` re-renders on.
 *
 * Surfaces cancelled/errored calls as their own honest callouts rather than
 * folding them into the total -- see `buildUsageRollup`'s doc
 * (packages/core/src/domain/usage-rollup.ts) for why a cancelled variant's
 * zero-cost usage row and an errored variant's MISSING usage row are both
 * deliberately kept out of `totalMeasuredCost`.
 */
function SessionSpend({ chatId }: { chatId: string }): JSX.Element {
  const [rollup, setRollup] = useState<UsageRollup | null>(null);
  const [failed, setFailed] = useState(false);

  const statusSignal = useGruntStore((s) =>
    Object.values(s.messages)
      .filter((m) => m.chatId === chatId && m.role === 'assistant')
      .map((m) => `${m.id}:${m.status}`)
      .sort()
      .join(',')
  );

  // Resets to the "Loading…" state only on a genuine chat switch -- a
  // same-chat re-fetch (triggered by statusSignal below) updates the
  // numbers in place instead of flashing back to a loading state.
  useEffect(() => {
    setRollup(null);
    setFailed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately chatId-only, see comment above.
  }, [chatId]);

  useEffect(() => {
    let cancelled = false;
    api.usage
      .get(chatId)
      .then((r) => {
        if (!cancelled) {
          setRollup(r);
          setFailed(false);
        }
      })
      .catch((err: unknown) => {
        console.error(`[grunt-web] failed to load usage for chat ${chatId}:`, err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- statusSignal is the deliberate re-fetch trigger described above.
  }, [chatId, statusSignal]);

  if (failed) return <EmptyState>Couldn&rsquo;t load spend for this chat.</EmptyState>;
  if (!rollup) return <EmptyState>Loading…</EmptyState>;
  if (rollup.profiles.length === 0 && rollup.totalCancelledCount === 0 && rollup.totalUnmeasuredErrorCount === 0) {
    return <EmptyState>No usage recorded in this chat yet.</EmptyState>;
  }

  return (
    <div data-testid="session-spend" className="space-y-2">
      <div className="flex justify-between text-sm font-medium">
        <span>Total</span>
        <span>{formatCost(rollup.totalMeasuredCost)}</span>
      </div>
      {rollup.profiles.map((p) => (
        <div key={p.profileId} className="flex justify-between text-sm">
          <span className="text-[var(--text-muted)]">{p.profileName}</span>
          <span>{formatCost(p.measuredCost)}</span>
        </div>
      ))}
      {rollup.totalCancelledCount > 0 && (
        <p className="text-xs text-[var(--text-faint)]">
          {rollup.totalCancelledCount} cancelled call{rollup.totalCancelledCount === 1 ? '' : 's'} -- usage unmeasured, not included above.
        </p>
      )}
      {rollup.totalUnmeasuredErrorCount > 0 && (
        <p className="text-xs text-[var(--text-faint)]">
          {rollup.totalUnmeasuredErrorCount} failed call{rollup.totalUnmeasuredErrorCount === 1 ? '' : 's'} -- usage unmeasured, not included above.
        </p>
      )}
    </div>
  );
}

function fmtParam(label: string, value: number | undefined): JSX.Element | null {
  if (value === undefined) return null;
  return (
    <div key={label} className="flex justify-between text-sm">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * The right pane. Exists specifically to surface the facts that cause harm
 * when hidden -- "this MCP server is down", "this chat can write to disk" --
 * so every section renders even when there is nothing to show yet, with an
 * honest empty state rather than being omitted. Tool grants, MCP health,
 * and spend all land in later tasks; this task wires the pane and its
 * collapse behaviour, not those features.
 */
export function Inspector({ chat, profile, collapsed, onToggleCollapsed }: InspectorProps): JSX.Element {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Expand inspector"
        aria-expanded={false}
        className="flex h-full w-9 flex-col items-center justify-center gap-2 border-l border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-muted)] hover:text-[var(--text)]"
      >
        <span className="[writing-mode:vertical-rl] text-xs tracking-wide">Inspector</span>
      </button>
    );
  }

  return (
    <aside
      aria-label="Inspector"
      className="flex h-full w-full flex-col overflow-y-auto border-l border-[var(--border)] bg-[var(--bg-raised)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold">Inspector</h2>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Collapse inspector"
          aria-expanded={true}
          className="text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          ✕
        </button>
      </div>

      <Section title="Profile parameters">
        {!chat ? (
          <EmptyState>No chat selected.</EmptyState>
        ) : !profile ? (
          <EmptyState>This chat's profile could not be loaded.</EmptyState>
        ) : (
          <div className="space-y-2">
            <div className="text-sm font-medium">{profile.name}</div>
            <div className="text-xs text-[var(--text-muted)]">{profile.modelId}</div>
            {profile.description && <p className="text-sm text-[var(--text-muted)]">{profile.description}</p>}
            <div className="space-y-1 pt-1">
              {fmtParam('Temperature', profile.params.temperature)}
              {fmtParam('Top P', profile.params.topP)}
              {fmtParam('Max output tokens', profile.params.maxOutputTokens)}
              {fmtParam('Thinking budget', profile.params.thinkingBudgetTokens)}
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-muted)]">Filesystem</span>
              <span>{profile.toolPolicy.fs}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-muted)]">Shell</span>
              <span>{profile.toolPolicy.shell ? 'on' : 'off'}</span>
            </div>
          </div>
        )}
      </Section>

      <Section title="Tool grants">
        {chat ? <GrantsSection chatId={chat.id} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>

      <Section title="MCP server health">
        <McpHealthSection />
      </Section>

      <Section title="Audit trail">
        {chat ? <AuditSection chatId={chat.id} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>

      <Section title="Running session spend">
        {chat ? <SessionSpend chatId={chat.id} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>
    </aside>
  );
}
