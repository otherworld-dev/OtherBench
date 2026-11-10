import { useState, type JSX } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { isDesktop, pickFolder } from '../desktop/bridge.js';
import { useChanged } from '../lib/useChanged.js';
import { WORKSPACE_ROOT_HELP, useServerPlatform, validateWorkspaceRoot } from '../lib/workspaceRoot.js';
import { ApiError, api } from '../state/api.js';
import { alsoActive } from '../state/machines.js';
import { useOtherBenchStore } from '../state/store.js';
import { useSectionSummary } from './InspectorSection.js';
import { FolderList } from '../components/FolderList.js';
import { PeerFolderBrowser } from '../components/PeerFolderBrowser.js';
import { isClaudeCodeProfile } from '../components/Composer.js';
import { folderName, workspaceConsequence } from './inspectorHelpers.js';

// ---------------------------------------------------------------------------
// Workspace root -- the single setting that unblocks the whole tool runtime.
// `PermissionBroker.decide` hard-denies every fs/shell tool call when
// `ctx.workspaceRoot` is null (packages/core/src/domain/permissions.ts), and
// before this section existed nothing in the web client ever set it: the
// tools, approval flow, and audit trail were all built and tested, but
// unreachable from the app because there was no UI path to the one field
// that turns them on.
// ---------------------------------------------------------------------------

/**
 * The paired machine a chat runs on, while it is reachable: its folders are the ones to choose, so the folder pickers
 * browse its locations (`PeerFolderBrowser`) instead of this machine's. Null for a chat that runs here, or on a machine
 * that isn't reachable now (a typed path still works).
 */
function useBrowsableMachine(chat: Chat): { nodeId: string; name: string } | null {
  const machines = useOtherBenchStore((s) => s.machines);
  if (!machines || chat.runsOn === machines.self.id) return null;
  const peer = machines.peers.find((p) => p.nodeId === chat.runsOn && p.status === 'reachable');
  return peer ? { nodeId: peer.nodeId, name: peer.name } : null;
}

/** Where this chat's turns run (v2 spec §5): this machine or a paired one, atop the Workspace section. Hidden until a machine is paired. */
export function RunsOn({ chat }: { chat: Chat }): JSX.Element | null {
  const machines = useOtherBenchStore((s) => s.machines);
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
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
export function OtherFoldersSection({ chat }: { chat: Chat }): JSX.Element {
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
  const upsertProject = useOtherBenchStore((s) => s.upsertProject);
  const project = useOtherBenchStore((s) => (chat.projectId === null ? null : (s.projects.find((p) => p.id === chat.projectId) ?? null)));
  const machines = useOtherBenchStore((s) => s.machines);
  // The native picker chooses a folder on this machine: only offered when that's where the chat runs.
  const runsHere = !machines || chat.runsOn === machines.self.id;
  const browse = useBrowsableMachine(chat);
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
          browse={browse}
          onSave={async (folders) => upsertChat(await api.chats.patch(chat.id, { folders }))}
        />
      </div>
    </div>
  );
}

export function WorkspaceSection({ chat, profile }: { chat: Chat; profile: Profile | null }): JSX.Element {
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
  const connections = useOtherBenchStore((s) => s.connections);
  const machines = useOtherBenchStore((s) => s.machines);
  const chats = useOtherBenchStore((s) => s.chats);
  const activeElsewhere = alsoActive(machines, chats, chat);
  const serverPlatform = useServerPlatform();
  const browse = useBrowsableMachine(chat);
  // The native picker chooses a folder on this machine: only offered when that's where the chat runs.
  const runsHere = !machines || chat.runsOn === machines.self.id;
  const [browsing, setBrowsing] = useState(false);
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
  // Done in the render that sees the new chat, so the last chat's form is never drawn under it.
  if (useChanged([chat.id])) {
    setEditing(false);
    setBrowsing(false);
    setError(null);
    setLocalWorkspaceRoot(undefined);
    // The draft is intentionally NOT synced on every keystroke of chat.workspaceRoot's own updater below.
  }

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

  // An app chat's folder is the app's folder (spec 2026-10-20-code-tab-design, "Calls I made"): the server
  // refuses a folder PATCH on it, and changing the app's folder moves every chat in it. So it's shown read-only,
  // with no control to change, clear or pick one; the app's form is where it changes.
  if (chat.appId) {
    const where =
      status?.status === 'unresolved'
        ? status.reason === 'other-machine'
          ? `The app's folder is on another machine${status.hint ? `: ${status.hint.path}` : ''}.`
          : `${status.hint?.path ?? "The app's folder"} isn't available on this machine.`
        : null;
    return (
      <div className="space-y-2" data-testid="workspace-section">
        {where ? (
          <p data-testid="workspace-unresolved" className="text-sm text-[var(--warn)]">
            {where}
          </p>
        ) : (
          <p data-testid="workspace-root-value" className="rounded bg-[var(--bg-sunken)] px-2 py-1 font-mono text-sm break-all">
            {displayedWorkspaceRoot ?? 'No folder'}
          </p>
        )}
        <p data-testid="workspace-app-folder" className="text-xs text-[var(--text-muted)]">
          Uses the app's folder. Edit the app to change it.
        </p>
        {activeElsewhere.map((a) => (
          <p key={`${a.machine}:${a.chatId}`} data-testid="workspace-also-active" role="status" className="text-xs text-[var(--warn)]">
            Also active on {a.machine}: "{a.title}" has a reply running in this folder.
          </p>
        ))}
        {displayedWorkspaceRoot && <p className="text-xs text-[var(--text-muted)]">{workspaceConsequence(profile)}</p>}
        {error && (
          <p data-testid="workspace-root-error" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    );
  }

  function openEdit(): void {
    setDraft(displayedWorkspaceRoot ?? '');
    setError(null);
    setBrowsing(false);
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
      console.error(`[otherbench-web] failed to update workspace root for chat ${chat.id}:`, err);
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
          placeholder={serverPlatform === 'win32' ? 'E:\\Git\\OtherBench' : '/home/user/project'}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 font-mono text-sm"
        />
        {browse &&
          (browsing ? (
            <PeerFolderBrowser
              nodeId={browse.nodeId}
              machine={browse.name}
              onPick={(picked) => {
                setDraft(picked);
                setError(null);
                setBrowsing(false);
              }}
              onClose={() => setBrowsing(false)}
            />
          ) : (
            <button type="button" onClick={() => setBrowsing(true)} className="btn px-2.5 py-1">
              Browse {browse.name}…
            </button>
          ))}
        {isDesktop() && runsHere && (
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
