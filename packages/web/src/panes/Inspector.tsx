import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { latestTodos } from '@grunt/core/domain/thread-tools.js';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import { pathForCard } from '@grunt/core/domain/computer-apps.js';
import type { AuditEntry, Chat, Grant } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';
import { isDesktop, pickFolder } from '../desktop/bridge.js';
import { usePolled } from '../lib/usePolled.js';
import { WORKSPACE_ROOT_HELP, useServerPlatform, validateWorkspaceRoot } from '../lib/workspaceRoot.js';
import { ApiError, api } from '../state/api.js';
import { alsoActive } from '../state/machines.js';
import { useGruntStore } from '../state/store.js';
import { ClaudeCodeSection } from './ClaudeCodeSection.js';
import { InspectorMemory } from './InspectorMemory.js';
import { InspectorProject } from './InspectorProject.js';
import { Section, useSectionSummary, type SummaryTone } from './InspectorSection.js';
import { FolderList } from '../components/FolderList.js';
import { TodoChecklist } from '../components/TodoChecklist.js';
import { isClaudeCodeProfile } from '../components/Composer.js';

export interface InspectorProps {
  chat: Chat | null;
  profile: Profile | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The collapsed strip can't be expanded (no chat selected, so there is nothing to inspect). */
  disabled?: boolean;
}

function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-[var(--text-faint)]">{children}</p>;
}

/** Running replies' checklists (spec 2026-10-12-thread-cards-design §7); the section exists only while one is running with a checklist. */
function ProgressSection({ chatId }: { chatId: string }): JSX.Element | null {
  const messages = useGruntStore((s) => s.messages);
  const running = useMemo(
    () =>
      Object.values(messages)
        .filter((m) => m.chatId === chatId && m.role === 'assistant' && m.status === 'streaming')
        .flatMap((m) => {
          const todos = latestTodos(m.parts);
          return todos ? [{ id: m.id, profileName: m.producedBy?.profileName ?? 'Assistant', todos }] : [];
        }),
    [messages, chatId]
  );
  if (running.length === 0) return null;
  return (
    <Section title="Progress" collapsible={false}>
      <div className="space-y-2">
        {running.map((r) => (
          <div key={r.id}>
            {running.length > 1 && <div className="text-xs text-[var(--text-muted)]">{r.profileName}</div>}
            <TodoChecklist todos={r.todos} streaming />
          </div>
        ))}
      </div>
    </Section>
  );
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
    return "Files and shell are turned off by policy for this chat's profile, so tools won't run here (Settings > Profiles).";
  }
  const fsPart = fs === 'readwrite' ? 'read and write files' : fs === 'read' ? 'read files' : null;
  const parts = [fsPart, shell ? 'run shell commands' : null].filter((p): p is string => p !== null);
  return `Can ${parts.join(' and ')} here, with approval for each call.`;
}

/** The last segment of a native path, for a section summary. */
function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Where this chat's turns run (v2 spec §5): this machine or a paired one, atop the Workspace section. Hidden until a machine is paired. */
function RunsOn({ chat }: { chat: Chat }): JSX.Element | null {
  const machines = useGruntStore((s) => s.machines);
  const upsertChat = useGruntStore((s) => s.upsertChat);
  const [error, setError] = useState<string | null>(null);
  if (!machines || machines.peers.length === 0) return null;
  const known = chat.runsOn === machines.self.id || machines.peers.some((p) => p.nodeId === chat.runsOn);

  async function choose(nodeId: string): Promise<void> {
    setError(null);
    try {
      upsertChat(await api.chats.patch(chat.id, { runsOn: nodeId }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change where this chat runs.");
    }
  }

  return (
    <div className="mb-2">
      <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <span className="shrink-0">Runs on</span>
        <select
          aria-label="Runs on"
          title="Its folder, tools and local models are those of the machine it runs on."
          value={chat.runsOn}
          onChange={(e) => void choose(e.target.value)}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1 text-sm text-[var(--text)]"
        >
          <option value={machines.self.id}>{machines.self.name} (this machine)</option>
          {machines.peers.map((p) => (
            <option key={p.nodeId} value={p.nodeId}>
              {p.name} ({p.status === 'reachable' ? 'connected' : p.status === 'unreachable' ? 'unreachable' : 'checking'})
            </option>
          ))}
          {!known && <option value={chat.runsOn}>A machine no longer paired</option>}
        </select>
      </label>
      {error && (
        <p role="alert" className="mt-1 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Folders the model may use besides the workspace (spec 2026-10-07-extra-folders):
 * the project's, which every chat in it gets, then this chat's own. Each is
 * read-only or read & write, within the profile's own file policy.
 */
function OtherFoldersSection({ chat }: { chat: Chat }): JSX.Element {
  const upsertChat = useGruntStore((s) => s.upsertChat);
  const upsertProject = useGruntStore((s) => s.upsertProject);
  const project = useGruntStore((s) => (chat.projectId === null ? null : (s.projects.find((p) => p.id === chat.projectId) ?? null)));
  const machines = useGruntStore((s) => s.machines);
  // The native picker chooses a folder on this machine: only offered when that's where the chat runs.
  const runsHere = !machines || chat.runsOn === machines.self.id;
  const views = [...(project?.folderViews ?? []), ...(chat.folderViews ?? [])];
  const away = views.filter((v) => v.status.status === 'unresolved').length;
  useSectionSummary(
    views.length === 0 ? 'none' : away > 0 ? `${views.length} · ${away} not found here` : String(views.length),
    away > 0 ? 'warn' : 'normal'
  );
  return (
    <div className="space-y-3">
      {!chat.workspace && <p className="text-xs text-[var(--text-muted)]">They apply once the chat has a workspace folder.</p>}
      {project && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium">Every chat in {project.name}</h4>
          <FolderList
            label="the project"
            views={project.folderViews ?? []}
            canPick={isDesktop()}
            onSave={async (folders) => upsertProject(await api.projects.patch(project.id, { folders }))}
          />
        </div>
      )}
      <div className="space-y-1">
        {project && <h4 className="text-xs font-medium">This chat</h4>}
        <FolderList
          label="this chat"
          views={chat.folderViews ?? []}
          canPick={isDesktop() && runsHere}
          onSave={async (folders) => upsertChat(await api.chats.patch(chat.id, { folders }))}
        />
      </div>
    </div>
  );
}

function WorkspaceSection({ chat, profile }: { chat: Chat; profile: Profile | null }): JSX.Element {
  const upsertChat = useGruntStore((s) => s.upsertChat);
  const connections = useGruntStore((s) => s.connections);
  const machines = useGruntStore((s) => s.machines);
  const chats = useGruntStore((s) => s.chats);
  const activeElsewhere = alsoActive(machines, chats, chat);
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
  // A folder that doesn't resolve here (v2 spec §6): say why rather than "no folder".
  const status = localWorkspaceRoot === undefined ? chat.workspaceStatus : undefined;
  const unresolved = status?.status === 'unresolved';
  const [elsewhere] = activeElsewhere;
  useSectionSummary(
    unresolved
      ? 'not found here'
      : !displayedWorkspaceRoot
        ? 'no folder'
        : elsewhere
          ? `${folderName(displayedWorkspaceRoot)} · also active on ${elsewhere.machine}`
          : folderName(displayedWorkspaceRoot),
    unresolved || (displayedWorkspaceRoot && elsewhere) ? 'warn' : 'normal'
  );

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
        {isDesktop() && (
          <button
            type="button"
            onClick={() => {
              pickFolder()
                .then((picked) => {
                  if (picked === null) return;
                  setDraft(picked);
                  setError(null);
                })
                .catch((err: unknown) => setError(`Couldn't open the folder picker: ${err instanceof Error ? err.message : String(err)}`));
            }}
            className="btn px-2.5 py-1"
          >
            Choose folder…
          </button>
        )}
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
            className="btn btn-primary px-2.5 py-1"
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
            className="btn px-2.5 py-1"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (status?.status === 'unresolved') {
    const where =
      status.reason === 'other-machine'
        ? `This chat's folder is on another machine${status.hint ? `: ${status.hint.path}` : ''}.`
        : status.reason === 'no-location-path'
          ? `This chat's folder is in a location with no folder on this machine yet${status.hint ? ` (elsewhere: ${status.hint.path})` : ''}.`
          : `${status.hint?.path ?? "This chat's folder"} doesn't exist on this machine.`;
    return (
      <div className="space-y-2" data-testid="workspace-section">
        <p data-testid="workspace-unresolved" className="text-sm text-[var(--warn)]">
          {where}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={openEdit} className="btn px-2 py-1">
            Choose folder…
          </button>
          <button
            type="button"
            onClick={() => void commit(null)}
            disabled={saving}
            className="btn px-2 py-1"
          >
            No folder
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

  if (!displayedWorkspaceRoot) {
    return (
      <div className="space-y-2" data-testid="workspace-section">
        <p className="text-sm text-[var(--text-faint)]">
          {profile && isClaudeCodeProfile(profile, connections)
            ? // A clean chat (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §1).
              'No folder: a plain chat. Web and MCP tools only; set a folder to let Claude Code use your files.'
            : 'No workspace folder is set, so filesystem and shell tools are unavailable.'}
        </p>
        <button type="button" onClick={openEdit} className="btn px-2 py-1">
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
      {localWorkspaceRoot === undefined && chat.workspace?.kind === 'location' && (
        <p data-testid="workspace-in-location" className="text-xs text-[var(--text-muted)]">
          In a location, so it works on any machine that knows where the location is.
        </p>
      )}
      {activeElsewhere.map((a) => (
        <p key={`${a.machine}:${a.chatId}`} data-testid="workspace-also-active" role="status" className="text-xs text-[var(--warn)]">
          Also active on {a.machine}: "{a.title}" has a reply running in this folder.
        </p>
      ))}
      <p className="text-xs text-[var(--text-muted)]">{workspaceConsequence(profile)}</p>
      <div className="flex gap-2">
        <button type="button" onClick={openEdit} className="btn px-2 py-1">
          Change…
        </button>
        <button
          type="button"
          onClick={() => void commit(null)}
          disabled={saving}
          className="btn btn-danger px-2 py-1"
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
  ok: 'bg-[var(--success)]',
  connecting: 'bg-[var(--accent)] animate-pulse',
  error: 'bg-[var(--danger)]',
  unknown: 'bg-[var(--text-faint)]',
  needs_auth: 'bg-[var(--warn)]',
};

function StatusDot({ status }: { status: McpServerHealth['status'] }): JSX.Element {
  return <span data-testid="mcp-status-dot" data-status={status} className={`inline-block h-2 w-2 shrink-0 rounded-full ${MCP_STATUS_COLOR[status]}`} aria-hidden="true" />;
}

/**
 * The MCP section's header line. With a profile, only the servers it has on
 * count towards a problem: one failing that this chat can't use shouldn't
 * flag every chat.
 */
function mcpSummary(servers: McpServerHealth[] | null, failed: boolean, onIds: string[] | null): { text: string | null; tone: SummaryTone } {
  if (failed) return { text: "couldn't load", tone: 'warn' };
  if (servers === null) return { text: null, tone: 'normal' };
  if (servers.length === 0) return { text: 'none', tone: 'normal' };
  const relevant = onIds ? servers.filter((s) => onIds.includes(s.id)) : servers;
  const failing = relevant.filter((s) => s.enabled && s.status === 'error').length;
  const signIn = relevant.filter((s) => s.enabled && s.status === 'needs_auth').length;
  const parts = [onIds ? `${relevant.length} of ${servers.length} on` : String(servers.length)];
  if (failing > 0) parts.push(`${failing} failing`);
  if (signIn > 0) parts.push(`${signIn} need${signIn === 1 ? 's' : ''} sign-in`);
  return { text: parts.join(' · '), tone: failing > 0 ? 'danger' : signIn > 0 ? 'warn' : 'normal' };
}

/**
 * "MCP servers" -- every configured server (enabled or not), its live
 * connection status, tool count, and a manual refresh action (`POST
 * /api/mcp-servers/:id/refresh`, task 25's reconnect-with-backoff still runs
 * on its own regardless). With the chat's profile loaded, each server also
 * gets a box for whether that profile may use it: its
 * `toolPolicy.mcpServerIds`, the same list as Settings > Profiles, so a
 * change applies to every chat on the profile. Servers it can't use are
 * dimmed, so a green dot doesn't read as "this chat has these tools".
 */
function McpServersSection({ profile }: { profile: Profile | null }): JSX.Element {
  const { data: servers, failed } = usePolled(() => api.mcpServers.list(), []);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const upsertProfile = useGruntStore((s) => s.upsertProfile);
  const profileIds = profile?.toolPolicy.mcpServerIds ?? [];
  // The list as last saved from here, until the profile prop catches up.
  const [localIds, setLocalIds] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const profileKey = `${profile?.id ?? ''}:${profileIds.join(',')}`;
  useEffect(() => {
    setLocalIds(null);
    setSaveError(null);
  }, [profileKey]);
  const onIds = localIds ?? profileIds;
  const summary = mcpSummary(servers, failed, profile ? onIds : null);
  useSectionSummary(summary.text, summary.tone);

  async function toggleOn(id: string): Promise<void> {
    if (!profile) return;
    const before = onIds;
    const next = before.includes(id) ? before.filter((x) => x !== id) : [...before, id];
    setLocalIds(next);
    setSaving(true);
    setSaveError(null);
    try {
      upsertProfile(await api.profiles.patch(profile.id, { toolPolicy: { mcpServerIds: next } }));
    } catch (err) {
      setLocalIds(before);
      setSaveError(`Couldn't save the change to ${profile.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

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
      {profile && <p className="text-xs text-[var(--text-muted)]">Ticked servers are on for {profile.name}, in every chat that uses it.</p>}
      {servers.map((s) => {
        const dim = profile !== null && !onIds.includes(s.id) ? 'opacity-50' : '';
        return (
          <div key={s.id} data-testid={`mcp-server-${s.id}`} className="flex items-center gap-2 text-sm">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              {profile && (
                <input
                  type="checkbox"
                  aria-label={`Use ${s.name} in ${profile.name}`}
                  checked={onIds.includes(s.id)}
                  disabled={saving}
                  onChange={() => void toggleOn(s.id)}
                />
              )}
              <span className={`flex min-w-0 flex-1 items-center gap-2 ${dim}`}>
                <StatusDot status={s.status} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
              </span>
            </label>
            <span className={`text-xs text-[var(--text-muted)] ${dim}`}>{!s.enabled ? 'disabled' : s.status === 'needs_auth' ? 'needs sign-in' : `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}`}</span>
            <button
              type="button"
              aria-label={`Refresh ${s.name}`}
              disabled={refreshingIds.has(s.id)}
              onClick={() => void refresh(s.id)}
              className="rounded-sm border border-[var(--border-strong)] px-1.5 py-0.5 text-xs hover:bg-[var(--bg-sunken)] disabled:opacity-50"
            >
              ↻
            </button>
          </div>
        );
      })}
      {saveError && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {saveError}
        </p>
      )}
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
      {servers.some((s) => s.status === 'needs_auth') && (
        <div className="space-y-1 pt-1">
          {servers
            .filter((s) => s.status === 'needs_auth')
            .map((s) => (
              <p key={s.id} className="text-xs text-[var(--warn)]">
                {`${s.name}: needs sign-in (Settings > MCP servers).`}
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
  useSectionSummary(failed ? "couldn't load" : shown === null ? null : shown.length === 0 ? 'none' : `${shown.length} active`);

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
          {/* A computer grant's app is shown whole (it wraps), so two grants for different programs can be told apart. */}
          <span className={`min-w-0 flex-1 ${g.constraint?.app ? 'break-all' : 'truncate'}`}>
            <span className="font-medium">{g.toolName}</span>
            <span className="ml-1.5 text-xs text-[var(--text-muted)]">
              {g.scope === 'always' ? 'always' : 'this chat'}
              {g.constraint?.pathPrefix ? ` · ${g.constraint.pathPrefix}` : ''}
              {g.constraint?.host ? ` · ${g.constraint.host}` : ''}
              {g.constraint?.commandExact ? ` · ${g.constraint.commandExact}` : ''}
              {g.constraint?.commandPrefix ? ` · ${g.constraint.commandPrefix} (any arguments)` : ''}
              {g.constraint?.live ? ` · live artifact call ${g.constraint.live.callId}` : ''}
              {g.constraint?.app ? (
                <>
                  {' · '}
                  <bdi>{pathForCard(g.constraint.app)}</bdi>
                </>
              ) : null}
            </span>
          </span>
          <button
            type="button"
            aria-label={`Revoke grant for ${g.toolName}`}
            disabled={revoking.has(g.id)}
            onClick={() => void revoke(g.id)}
            className="btn btn-danger px-1.5 py-0.5"
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
  if (grantedBy.startsWith('live:')) return 'live artifact';
  switch (grantedBy) {
    case 'auto_read': return 'auto-read';
    case 'policy': return 'policy';
    case 'ask:once': return 'asked: once';
    case 'ask:chat': return 'asked: this chat';
    case 'ask:always': return 'asked: always';
    case 'deny:policy': return 'denied by policy';
    case 'deny:user': return 'denied by you';
    case 'auto': return 'auto mode';
    case 'deny:cancelled': return 'stopped (not denied)';
    case 'deny:auto': return 'blocked by auto mode';
    case 'deny:plan': return 'refused: no plan approved yet';
    case 'deny:unattended': return 'refused: nobody to approve (scheduled run)';
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
  useSectionSummary(
    failed ? "couldn't load" : entries === null ? null : entries.length === 0 ? 'none' : `${entries.length} call${entries.length === 1 ? '' : 's'}`
  );

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
 * The "Spend" section's body -- fetches task 28's usage
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

  const empty = rollup !== null && rollup.profiles.length === 0 && rollup.totalCancelledCount === 0 && rollup.totalUnmeasuredErrorCount === 0;
  useSectionSummary(failed ? "couldn't load" : rollup === null ? null : empty ? 'none' : formatCost(rollup.totalMeasuredCost));

  if (failed) return <EmptyState>Couldn&rsquo;t load spend for this chat.</EmptyState>;
  if (!rollup) return <EmptyState>Loading…</EmptyState>;
  if (empty) {
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

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }): JSX.Element {
  return (
    <>
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-words">
        {children}
      </dd>
    </>
  );
}

/** The chat's profile: name and model, then its parameters and tool policy as a compact grid. */
function ProfileSection({ profile }: { profile: Profile | null }): JSX.Element {
  useSectionSummary(profile ? profile.name : 'not loaded', profile ? 'normal' : 'warn');
  if (!profile) return <EmptyState>This chat's profile could not be loaded.</EmptyState>;
  const { temperature, topP, maxOutputTokens, thinkingBudgetTokens } = profile.params;
  return (
    <div className="space-y-1.5">
      <div className="min-w-0 text-sm">
        <span className="font-medium">{profile.name}</span> <span className="text-xs break-all text-[var(--text-muted)]">{profile.modelId}</span>
      </div>
      {profile.description && (
        <p title={profile.description} className="line-clamp-2 text-xs text-[var(--text-muted)]">
          {profile.description}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {temperature !== undefined && <Row label="Temperature">{temperature}</Row>}
        {topP !== undefined && <Row label="Top P">{topP}</Row>}
        {maxOutputTokens !== undefined && <Row label="Max output tokens">{maxOutputTokens}</Row>}
        {thinkingBudgetTokens !== undefined && <Row label="Thinking budget">{thinkingBudgetTokens}</Row>}
        <Row label="Filesystem">{profile.toolPolicy.fs}</Row>
        <Row label="Shell">{profile.toolPolicy.shell ? 'on' : 'off'}</Row>
        <Row label="Global memory" testId="profile-global-memory">
          {profile.useGlobalMemory === false ? 'off' : 'on'}
        </Row>
      </dl>
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
 * honest empty state rather than being omitted. Most sections start closed
 * to keep the pane short, but each header carries a one-line summary and a
 * problem colours it and opens it (see InspectorSection).
 */
export function Inspector({ chat, profile, collapsed, onToggleCollapsed, disabled = false }: InspectorProps): JSX.Element {
  // The chat's project, when it's loaded: the memory section needs both.
  const memoryProject = useGruntStore((s) => (chat?.projectId ? (s.projects.find((p) => p.id === chat.projectId) ?? null) : null));
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={disabled ? undefined : onToggleCollapsed}
        aria-label="Expand inspector"
        aria-expanded={false}
        aria-disabled={disabled || undefined}
        title={disabled ? 'Select a chat to see its details' : undefined}
        className="flex h-full w-9 flex-col items-center justify-center gap-2 border-l border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-muted)] hover:text-[var(--text)] aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:text-[var(--text-muted)]"
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
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
        <h2 className="label-caps text-base">Inspector</h2>
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

      <Section title="Project" collapsible={false}>
        {chat ? <InspectorProject chat={chat} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>

      {chat && <ProgressSection chatId={chat.id} />}

      <Section title="Workspace" defaultOpen>
        {chat ? (
          <>
            <RunsOn chat={chat} />
            <WorkspaceSection chat={chat} profile={profile} />
          </>
        ) : (
          <EmptyState>No chat selected.</EmptyState>
        )}
      </Section>

      {chat && (
        <Section title="Other folders" hint="Folders the model can also work in besides the workspace, by absolute path.">
          <OtherFoldersSection chat={chat} />
        </Section>
      )}

      <Section title="Profile">{chat ? <ProfileSection profile={profile} /> : <EmptyState>No chat selected.</EmptyState>}</Section>

      {chat && <ClaudeCodeInspectorSection chatId={chat.id} />}

      <Section title="Tool grants">
        {chat ? <GrantsSection chatId={chat.id} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>

      <Section title="MCP servers">
        <McpServersSection profile={chat ? profile : null} />
      </Section>

      <Section title="Audit trail">
        {chat ? <AuditSection chatId={chat.id} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>

      {chat && memoryProject && (
        <Section title="Project memory">
          {/* Keyed by project so a response still in flight for the previous project can never land in this one. */}
          <InspectorMemory key={memoryProject.id} chat={chat} project={memoryProject} />
        </Section>
      )}

      <Section title="Spend">
        {chat ? <SessionSpend chatId={chat.id} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>
    </aside>
  );
}
