import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { AuditEntry, Chat, Grant } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';
import { usePolled } from '../lib/usePolled.js';
import { WORKSPACE_ROOT_HELP, useServerPlatform, validateWorkspaceRoot } from '../lib/workspaceRoot.js';
import { ApiError, api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { ClaudeCodeSection } from './ClaudeCodeSection.js';
import { InspectorMemory } from './InspectorMemory.js';
import { InspectorProject } from './InspectorProject.js';

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
// `usePolled` moved to ../lib/usePolled.js so the Settings > MCP servers
// panel can reuse the exact same "no push channel, poll and don't flash to
// loading on a routine re-fetch" behaviour for its own health list.

// ---------------------------------------------------------------------------
// Workspace root -- the single setting that unblocks the whole tool runtime.
// `PermissionBroker.decide` hard-denies every fs/shell tool call when
// `ctx.workspaceRoot` is null (packages/core/src/domain/permissions.ts), and
// before this section existed nothing in the web client ever set it: the
// tools, approval flow, and audit trail were all built and tested, but
// unreachable from the app because there was no UI path to the one field
// that turns them on.
// ---------------------------------------------------------------------------

/** Plain-language consequence of the current tool policy against a workspace that IS set -- makes real access legible, not just "a path is configured". */
function workspaceConsequence(profile: Profile | null): string {
  const fs = profile?.toolPolicy.fs ?? 'off';
  const shell = profile?.toolPolicy.shell ?? false;
  if (fs === 'off' && !shell) {
    return "This chat's profile currently has filesystem and shell access turned off by policy, so tools still won't run here -- enable them for this profile in Settings > Profiles.";
  }
  const fsPart = fs === 'readwrite' ? 'read and write files' : fs === 'read' ? 'read files' : null;
  const parts = [fsPart, shell ? 'run shell commands' : null].filter((p): p is string => p !== null);
  return `This chat's profile can ${parts.join(' and ')} under this folder, subject to approval for each call.`;
}

function WorkspaceSection({ chat, profile }: { chat: Chat; profile: Profile | null }): JSX.Element {
  const upsertChat = useGruntStore((s) => s.upsertChat);
  const serverPlatform = useServerPlatform();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.workspaceRoot ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistic override of `chat.workspaceRoot`, exactly like GrantsSection's
  // `localGrants` above: `upsertChat` below updates the SAME store App.tsx
  // reads `chats` from, so a real render eventually flows this component a
  // fresh `chat` prop -- but that is at least one more render tick away, and
  // "Save" doing visibly nothing for a moment reads as broken. `undefined` =
  // no override yet, defer to the prop.
  const [localWorkspaceRoot, setLocalWorkspaceRoot] = useState<string | null | undefined>(undefined);

  // A genuine chat switch resets the form and drops the optimistic override
  // -- but NOT a re-render mid-edit, which would otherwise wipe out whatever
  // the user is currently typing.
  useEffect(() => {
    setEditing(false);
    setError(null);
    setLocalWorkspaceRoot(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draft is intentionally NOT synced on every keystroke of chat.workspaceRoot's own updater below.
  }, [chat.id]);

  const displayedWorkspaceRoot = localWorkspaceRoot !== undefined ? localWorkspaceRoot : chat.workspaceRoot;

  function openEdit(): void {
    setDraft(displayedWorkspaceRoot ?? '');
    setError(null);
    setEditing(true);
  }

  async function commit(nextWorkspaceRoot: string | null): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.chats.patch(chat.id, { workspaceRoot: nextWorkspaceRoot });
      upsertChat(updated);
      setLocalWorkspaceRoot(updated.workspaceRoot);
      setEditing(false);
      setDraft(updated.workspaceRoot ?? '');
    } catch (err) {
      console.error(`[grunt-web] failed to update workspace root for chat ${chat.id}:`, err);
      setError(err instanceof ApiError ? err.message : 'Save failed -- please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(): Promise<void> {
    const validationError = validateWorkspaceRoot(draft, serverPlatform);
    if (validationError) {
      setError(validationError);
      return;
    }
    await commit(draft.trim());
  }

  if (editing) {
    return (
      <div className="space-y-2" data-testid="workspace-section">
        <label className="block text-xs font-medium text-[var(--text-muted)]" htmlFor="workspace-root-input">
          Workspace folder (native absolute path)
        </label>
        <input
          id="workspace-root-input"
          aria-label="Workspace folder"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          placeholder={serverPlatform === 'win32' ? 'E:\\Git\\Grunt' : '/home/user/project'}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-sm"
        />
        <p className="text-xs text-[var(--text-muted)]">{WORKSPACE_ROOT_HELP}</p>
        {error && (
          <p data-testid="workspace-root-error" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-text)] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraft(displayedWorkspaceRoot ?? '');
              setError(null);
            }}
            className="rounded border border-[var(--border)] px-2.5 py-1 text-xs"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (!displayedWorkspaceRoot) {
    return (
      <div className="space-y-2" data-testid="workspace-section">
        <p className="text-sm text-[var(--text-faint)]">No workspace folder is set. Filesystem and shell tools are unavailable in this chat until one is.</p>
        <button type="button" onClick={openEdit} className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-sunken)]">
          Set workspace…
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="workspace-section">
      <p data-testid="workspace-root-value" className="rounded bg-[var(--bg-sunken)] px-2 py-1 font-mono text-sm break-all">
        {displayedWorkspaceRoot}
      </p>
      <p className="text-xs text-[var(--text-muted)]">{workspaceConsequence(profile)}</p>
      <div className="flex gap-2">
        <button type="button" onClick={openEdit} className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-sunken)]">
          Change…
        </button>
        <button
          type="button"
          onClick={() => void commit(null)}
          disabled={saving}
          className="rounded border border-[var(--danger)] px-2 py-1 text-xs text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white disabled:opacity-50"
        >
          Clear
        </button>
      </div>
      {error && (
        <p data-testid="workspace-root-error" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
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

/** Short, human label for how a gated call was authorised; the raw value stays available as a tooltip. Unknown values pass through. */
function grantedByLabel(grantedBy: string): string {
  if (grantedBy.startsWith('grant:')) return 'grant';
  switch (grantedBy) {
    case 'auto_read': return 'auto-read';
    case 'policy': return 'policy';
    case 'ask:once': return 'asked: once';
    case 'ask:chat': return 'asked: this chat';
    case 'ask:always': return 'asked: always';
    case 'deny:policy': return 'denied by policy';
    case 'deny:user': return 'denied by you';
    case 'auto': return 'auto mode';
    case 'deny:auto': return 'blocked by auto mode';
    default: return grantedBy;
  }
}

const AUDIT_COLLAPSED_COUNT = 5;

/** "Show all (N)" / "Show fewer" toggle shared by the capped Inspector lists. */
function ShowAllToggle({ total, limit, expanded, onToggle }: { total: number; limit: number; expanded: boolean; onToggle: () => void }): JSX.Element | null {
  if (total <= limit) return null;
  return (
    <button type="button" onClick={onToggle} aria-expanded={expanded} className="mt-2 text-xs text-[var(--text-muted)] underline hover:text-[var(--text)]">
      {expanded ? 'Show fewer' : `Show all (${total})`}
    </button>
  );
}

/** "Audit trail" -- every gated tool call in this chat: tool, how it was authorised, a short result summary (never raw output/content -- redaction happens server-side, see GruntToolProvider), and duration. Newest first. */
function AuditSection({ chatId }: { chatId: string }): JSX.Element {
  const { data: entries, failed } = usePolled(() => api.audit.list(chatId), [chatId]);
  const [expanded, setExpanded] = useState(false);

  if (failed) return <EmptyState>Couldn&rsquo;t load the audit trail for this chat.</EmptyState>;
  if (entries === null) return <EmptyState>Loading…</EmptyState>;
  if (entries.length === 0) return <EmptyState>No tool calls recorded in this chat yet.</EmptyState>;

  const sorted: AuditEntry[] = [...entries].sort((a, b) => b.createdAt - a.createdAt);

  const shown = expanded ? sorted : sorted.slice(0, AUDIT_COLLAPSED_COUNT);

  return (
    <>
      <ul data-testid="audit-trail" className="space-y-2">
        {shown.map((entry) => (
          <li key={entry.id} data-testid={`audit-${entry.id}`} className="text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{entry.toolName}</span>
              <span className="text-xs text-[var(--text-muted)]">{formatAuditTime(entry.createdAt)}</span>
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {entry.resultSummary} · <span title={entry.grantedBy}>{grantedByLabel(entry.grantedBy)}</span> · {entry.durationMs}ms
            </div>
          </li>
        ))}
      </ul>
      <ShowAllToggle total={sorted.length} limit={AUDIT_COLLAPSED_COUNT} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
    </>
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

function ClaudeCodeInspectorSection({ chatId }: { chatId: string }): JSX.Element | null {
  const hasSession = useGruntStore((s) => Object.values(s.messages).some((m) => m.chatId === chatId && !!m.engineMeta));
  if (!hasSession) return null;
  return (
    <Section title="Claude Code session">
      <ClaudeCodeSection chatId={chatId} />
    </Section>
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
  // The chat's project, when it's loaded: the memory section needs both.
  const memoryProject = useGruntStore((s) => (chat?.projectId ? (s.projects.find((p) => p.id === chat.projectId) ?? null) : null));
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

      <Section title="Project">
        {chat ? <InspectorProject chat={chat} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>

      {chat && memoryProject && (
        <Section title="Project memory">
          {/* Keyed by project so a response still in flight for the previous project can never land in this one. */}
          <InspectorMemory key={memoryProject.id} chat={chat} project={memoryProject} />
        </Section>
      )}

      <Section title="Workspace">
        {chat ? <WorkspaceSection chat={chat} profile={profile} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>

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

      {chat && <ClaudeCodeInspectorSection chatId={chat.id} />}

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
