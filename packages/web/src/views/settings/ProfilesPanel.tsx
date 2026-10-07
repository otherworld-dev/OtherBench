import { useEffect, useState, type JSX } from 'react';
import type { FsMode, ModelParams, Profile } from '@grunt/core/types/config.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';
import { ApiError, api, type CreateProfileBody } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';
import { machineName } from '../../state/machines.js';

const HEX_COLOUR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Sentinel distinguishing "left blank, omit this param" from "typed something that isn't a number" -- `ModelParams`' fields are plain optional numbers (no `null` variant, unlike `ModelInfo`'s price fields), so blank must become "key absent", not "key: null". */
const INVALID = Symbol('invalid-param');

function parseParamField(raw: string): number | undefined | typeof INVALID {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : INVALID;
}

function paramsToDraft(params: ModelParams): { temperature: string; topP: string; maxOutputTokens: string; thinkingBudgetTokens: string } {
  return {
    temperature: params.temperature?.toString() ?? '',
    topP: params.topP?.toString() ?? '',
    maxOutputTokens: params.maxOutputTokens?.toString() ?? '',
    thinkingBudgetTokens: params.thinkingBudgetTokens?.toString() ?? '',
  };
}

interface ProfileFormProps {
  /** `null` means "creating a new profile". */
  profile: Profile | null;
  /** Every configured MCP server (enabled or not -- see the allowlist checklist below for why disabled ones stay visible), for the `toolPolicy.mcpServerIds` checklist. */
  mcpServers: McpServerHealth[];
  /** True when `GET /mcp-servers` failed -- distinguishes "genuinely no servers configured" from "couldn't find out" so this access-control checklist never claims the latter is the former. See `ProfilesPanel`'s `mcpServersFailed` doc. */
  mcpServersFailed: boolean;
  onSaved: (profile: Profile) => void;
  onDeleted: (id: string) => void;
  onCancel: () => void;
}

/**
 * Add/edit form for one profile -- name, description, colour, the
 * connection + model it runs against, system prompt, sampling params, tool
 * policy, MCP server allowlist, and default status. Keyed by `profile?.id`
 * from the parent (see `ProfilesPanel`) so switching the selected profile
 * remounts with fresh local state instead of resyncing a pile of `useState`
 * via an effect.
 *
 * The model select stores `ModelInfo.modelId` (the provider's own model
 * string, e.g. "llama3.2"), NOT `ModelInfo.id` (Grunt's row id) --
 * `Profile.modelId` is matched against `ModelInfo.modelId` at request time
 * (see `resolveProfile`, packages/server/src/profile-resolution.ts), so
 * storing the row id here would silently fail to resolve a model at all.
 */
function ProfileForm({ profile, mcpServers, mcpServersFailed, onSaved, onDeleted, onCancel }: ProfileFormProps): JSX.Element {
  const connections = useGruntStore((s) => s.connections);
  const models = useGruntStore((s) => s.models);
  const chats = useGruntStore((s) => s.chats);

  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [colour, setColour] = useState(profile?.colour ?? '');
  const [connectionId, setConnectionId] = useState(profile?.connectionId ?? connections[0]?.id ?? '');
  const [modelId, setModelId] = useState(profile?.modelId ?? '');
  const [systemPrompt, setSystemPrompt] = useState(profile?.systemPrompt ?? '');
  const [paramsDraft, setParamsDraft] = useState(() => paramsToDraft(profile?.params ?? {}));
  const [fs, setFs] = useState<FsMode>(profile?.toolPolicy.fs ?? 'off');
  const [shell, setShell] = useState(profile?.toolPolicy.shell ?? false);
  // Artifacts (Deck #896): on unless the profile turned them off.
  const [artifacts, setArtifacts] = useState(profile?.toolPolicy.artifacts ?? true);
  const [approvalMode, setApprovalMode] = useState<'always_ask' | 'ask_on_mutate'>(profile?.toolPolicy.approvalMode ?? 'always_ask');
  const [mcpServerIds, setMcpServerIds] = useState<string[]>(profile?.toolPolicy.mcpServerIds ?? []);
  const [agentWeb, setAgentWeb] = useState(profile?.toolPolicy.agentWeb ?? true);
  const [agentMcp, setAgentMcp] = useState(profile?.toolPolicy.agentMcp ?? true);
  const [isDefault, setIsDefault] = useState(profile?.isDefault ?? false);

  function toggleMcpServer(id: string): void {
    setMcpServerIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isClaudeCode = connections.find((c) => c.id === connectionId)?.kind === 'claude_code';
  const modelsForConnection = models.filter((m) => m.connectionId === connectionId);

  function handleConnectionChange(newConnectionId: string): void {
    setConnectionId(newConnectionId);
    const stillValid = models.some((m) => m.connectionId === newConnectionId && m.modelId === modelId);
    if (!stillValid) {
      const first = models.find((m) => m.connectionId === newConnectionId);
      setModelId(first?.modelId ?? '');
    }
  }

  async function handleSave(): Promise<void> {
    if (name.trim().length === 0) {
      setError('"Name" is required.');
      return;
    }
    if (!connectionId) {
      setError('Choose a connection.');
      return;
    }
    if (!modelId) {
      setError('Choose a model.');
      return;
    }

    const temperature = parseParamField(paramsDraft.temperature);
    const topP = parseParamField(paramsDraft.topP);
    const maxOutputTokens = parseParamField(paramsDraft.maxOutputTokens);
    const thinkingBudgetTokens = parseParamField(paramsDraft.thinkingBudgetTokens);
    if ([temperature, topP, maxOutputTokens, thinkingBudgetTokens].includes(INVALID)) {
      setError('Params must be numbers, or left blank.');
      return;
    }

    const params: ModelParams = {};
    if (temperature !== undefined) params.temperature = temperature as number;
    if (topP !== undefined) params.topP = topP as number;
    if (maxOutputTokens !== undefined) params.maxOutputTokens = maxOutputTokens as number;
    if (thinkingBudgetTokens !== undefined) params.thinkingBudgetTokens = thinkingBudgetTokens as number;

    const body: CreateProfileBody = {
      name: name.trim(),
      description: description.trim().length > 0 ? description.trim() : null,
      colour: colour.trim().length > 0 ? colour.trim() : null,
      connectionId,
      modelId,
      systemPrompt: systemPrompt.trim().length > 0 ? systemPrompt.trim() : null,
      params,
      toolPolicy: isClaudeCode ? { fs, shell, approvalMode, mcpServerIds, agentWeb, agentMcp, artifacts } : { fs, shell, approvalMode, mcpServerIds, artifacts },
      isDefault,
    };

    setSaving(true);
    setError(null);
    try {
      const saved = profile ? await api.profiles.patch(profile.id, body) : await api.profiles.create(body);
      onSaved(saved);
    } catch (err) {
      console.error('[grunt-web] failed to save profile:', err);
      setError(errorMessage(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!profile) return;
    // Same reasoning as ConnectionsPanel's handleDelete: the store already
    // holds the exact dependent-chat count (removeProfile, state/store.ts),
    // so put the real number in this one confirmation rather than adding a
    // second step.
    const dependentChatCount = chats.filter((c) => c.profileId === profile.id).length;
    const consequence =
      dependentChatCount > 0
        ? ` This deletes ${dependentChatCount} chat${dependentChatCount === 1 ? '' : 's'} built on it (including ${dependentChatCount === 1 ? 'its' : 'their'} message history).`
        : '';
    // With paired machines the deletion syncs, and their copies of those chats go too (v2 spec §4).
    const everywhere =
      dependentChatCount > 0 && (useGruntStore.getState().machines?.peers.length ?? 0) > 0
        ? ' Paired machines delete them too when they next sync. Archive the profile instead to keep them.'
        : '';
    const ok = window.confirm(`Delete profile "${profile.name}"?${consequence}${everywhere} This cannot be undone.`);
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      await api.profiles.delete(profile.id);
      onDeleted(profile.id);
    } catch (err) {
      console.error(`[grunt-web] failed to delete profile ${profile.id}:`, err);
      setError(errorMessage(err, 'Delete failed -- please try again.'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div data-testid="profile-form" className="max-w-xl space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="profile-name">
          Name
        </label>
        <input
          id="profile-name"
          aria-label="Profile name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="profile-description">
          Description
        </label>
        <textarea
          id="profile-description"
          aria-label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="profile-colour">
          Colour
        </label>
        <div className="flex items-center gap-2">
          <input
            id="profile-colour"
            aria-label="Colour"
            value={colour}
            onChange={(e) => setColour(e.target.value)}
            placeholder="#2f6fed (optional)"
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
          />
          {HEX_COLOUR_RE.test(colour.trim()) && (
            <span aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full border border-[var(--border)]" style={{ background: colour.trim() }} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="profile-connection">
            Connection
          </label>
          <select
            id="profile-connection"
            aria-label="Connection"
            value={connectionId}
            onChange={(e) => handleConnectionChange(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
          >
            <option value="" disabled>
              Choose a connection
            </option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="profile-model">
            Model
          </label>
          <select
            id="profile-model"
            aria-label="Model"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={modelsForConnection.length === 0}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm disabled:opacity-50"
          >
            <option value="" disabled>
              Choose a model
            </option>
            {modelsForConnection.map((m) => (
              <option key={m.id} value={m.modelId}>
                {m.displayName} ({m.modelId})
              </option>
            ))}
          </select>
          {modelsForConnection.length === 0 && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">No models for this connection yet -- discover some in the Connections tab.</p>
          )}
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="profile-system-prompt">
          System prompt
        </label>
        <textarea
          id="profile-system-prompt"
          aria-label="System prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={3}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Params (blank = provider default)</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {!isClaudeCode && (
            <>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Temperature
            <input
              aria-label="Temperature"
              value={paramsDraft.temperature}
              onChange={(e) => setParamsDraft((d) => ({ ...d, temperature: e.target.value }))}
              placeholder="—"
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Top P
            <input
              aria-label="Top P"
              value={paramsDraft.topP}
              onChange={(e) => setParamsDraft((d) => ({ ...d, topP: e.target.value }))}
              placeholder="—"
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
            />
          </label>
            </>
          )}
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Max output tokens
            <input
              aria-label="Max output tokens"
              value={paramsDraft.maxOutputTokens}
              onChange={(e) => setParamsDraft((d) => ({ ...d, maxOutputTokens: e.target.value }))}
              placeholder="—"
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Thinking budget tokens
            <input
              aria-label="Thinking budget tokens"
              value={paramsDraft.thinkingBudgetTokens}
              onChange={(e) => setParamsDraft((d) => ({ ...d, thinkingBudgetTokens: e.target.value }))}
              placeholder="—"
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
            />
          </label>
        </div>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">{isClaudeCode ? 'Claude Code tools' : 'Tool policy'}</span>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            {isClaudeCode ? 'Files' : 'Filesystem'}
            <select
              aria-label="Filesystem access"
              value={fs}
              onChange={(e) => setFs(e.target.value as FsMode)}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
            >
              <option value="off">off</option>
              <option value="read">read</option>
              <option value="readwrite">readwrite</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            Approval mode
            <select
              aria-label="Approval mode"
              value={approvalMode}
              onChange={(e) => setApprovalMode(e.target.value as 'always_ask' | 'ask_on_mutate')}
              className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
            >
              <option value="always_ask">always ask</option>
              <option value="ask_on_mutate">ask on mutate</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 self-end pb-1 text-xs text-[var(--text)]">
            <input type="checkbox" aria-label={isClaudeCode ? 'Bash' : 'Shell access'} checked={shell} onChange={(e) => setShell(e.target.checked)} />
            {isClaudeCode ? 'Bash' : 'Shell access'}
          </label>
          <label className="flex items-center gap-1.5 self-end pb-1 text-xs text-[var(--text)]">
            <input type="checkbox" aria-label="Artifacts" checked={artifacts} onChange={(e) => setArtifacts(e.target.checked)} />
            Artifacts
          </label>
          {isClaudeCode && (
            <>
              <label className="flex items-center gap-1.5 self-end pb-1 text-xs text-[var(--text)]">
                <input type="checkbox" aria-label="Web tools" checked={agentWeb} onChange={(e) => setAgentWeb(e.target.checked)} />
                Web tools
              </label>
              <label className="flex items-center gap-1.5 self-end pb-1 text-xs text-[var(--text)]">
                <input type="checkbox" aria-label="MCP servers from your Claude config" checked={agentMcp} onChange={(e) => setAgentMcp(e.target.checked)} />
                MCP servers from your Claude config
              </label>
            </>
          )}
        </div>
      </div>

      {!isClaudeCode && (
        <div>
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">MCP servers this profile may use</span>
          <p className="mb-1.5 text-xs text-[var(--text-muted)]">
            This is an access-control decision, not a convenience filter: the permission broker treats a server being checked here as this profile
            having authorised its tools. A tool from a server that is <em>not</em> checked is hard-denied, with no approval prompt offered for it.
          </p>
          {mcpServersFailed ? (
            <p role="alert" data-testid="mcp-allowlist-error" className="text-xs text-[var(--danger)]">
              Couldn&rsquo;t load MCP servers -- this profile&rsquo;s existing allowlist ({mcpServerIds.length} server
              {mcpServerIds.length === 1 ? '' : 's'}) is preserved, but can&rsquo;t be shown or edited until this loads. Reload the page, or
              check Settings &gt; MCP Servers.
            </p>
          ) : mcpServers.length === 0 ? (
            <p className="text-xs text-[var(--text-faint)]">No MCP servers configured yet -- add one in Settings &gt; MCP Servers.</p>
          ) : (
            <div data-testid="mcp-server-allowlist" className="space-y-1">
              {mcpServers.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" aria-label={`Allow MCP server ${s.name}`} checked={mcpServerIds.includes(s.id)} onChange={() => toggleMcpServer(s.id)} />
                  {s.name}
                  {!s.enabled && <span className="text-xs text-[var(--text-muted)]">(disabled -- contributes no tools until re-enabled)</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <label className="flex items-center gap-1.5 text-sm">
        <input type="checkbox" aria-label="Default profile" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Default profile (used for new chats)
      </label>

      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-text)] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-[var(--border)] px-3 py-1.5 text-sm">
          Cancel
        </button>
        {profile && (
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
            className="ml-auto rounded border border-[var(--danger)] px-3 py-1.5 text-sm text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        )}
      </div>
    </div>
  );
}

function ProfileRow({
  profile,
  connectionName,
  onlyOn,
  active,
  onSelect,
}: {
  profile: Profile;
  connectionName: string;
  /** The other machine its connection only works on, if it does. */
  onlyOn: string | null;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        data-testid={`profile-row-${profile.id}`}
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
          active ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'hover:bg-[var(--bg-sunken)]'
        }`}
      >
        {profile.colour && HEX_COLOUR_RE.test(profile.colour) ? (
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: profile.colour }} />
        ) : (
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-[var(--text-faint)]" />
        )}
        <span className="min-w-0 flex-1 truncate">{profile.name}</span>
        {profile.isDefault && <span className={`shrink-0 text-xs ${active ? '' : 'text-[var(--text-muted)]'}`}>default</span>}
      </button>
      <p className={`px-2 pb-1 truncate text-xs ${active ? 'text-[var(--accent-text)]' : 'text-[var(--text-muted)]'}`}>
        {connectionName} · {profile.modelId}
        {onlyOn && <span data-testid="profile-only-on"> · Runs on {onlyOn} only</span>}
      </p>
    </li>
  );
}

/**
 * Profiles panel (task: settings UI, brief item 3). Full CRUD over the
 * named profiles that drive every chat -- name/description/colour, which
 * connection + model to run against, system prompt, sampling params, tool
 * policy (including the MCP server allowlist, `toolPolicy.mcpServerIds`),
 * and default status.
 *
 * MCP servers aren't reference data in the global store the way
 * connections/models/profiles are (see McpServersPanel's doc for why: its
 * health is genuinely live/polled data, not a CRUD row cache) -- so this
 * panel fetches the health-shaped list itself, once, purely to populate
 * `ProfileForm`'s allowlist checklist with names + enabled state.
 */
export function ProfilesPanel(): JSX.Element {
  const connections = useGruntStore((s) => s.connections);
  const profiles = useGruntStore((s) => s.profiles);
  const upsertProfile = useGruntStore((s) => s.upsertProfile);
  const removeProfile = useGruntStore((s) => s.removeProfile);

  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerHealth[]>([]);
  // INVARIANT: an empty `mcpServers` array must not by itself mean "no
  // servers configured" -- that's also exactly what a failed fetch leaves
  // behind, and this list backs an access-control checklist
  // (toolPolicy.mcpServerIds), not a convenience filter. Tracked separately
  // so the form can tell "genuinely none" apart from "couldn't find out"
  // rather than letting the empty local array quietly stand in for both.
  const [mcpServersFailed, setMcpServersFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.mcpServers
      .list()
      .then((servers) => {
        if (!cancelled) {
          setMcpServers(servers);
          setMcpServersFailed(false);
        }
      })
      .catch((err: unknown) => {
        console.error('[grunt-web] failed to load MCP servers for the profile allowlist:', err);
        if (!cancelled) setMcpServersFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = editingId && editingId !== 'new' ? (profiles.find((p) => p.id === editingId) ?? null) : null;
  const showForm = editingId === 'new' || selected !== null;
  const connectionName = (id: string): string => connections.find((c) => c.id === id)?.name ?? 'Unknown connection';
  const machines = useGruntStore((s) => s.machines);
  /** A profile whose connection works only on another machine can only run chats there. */
  const onlyOn = (connectionId: string): string | null => {
    const availability = connections.find((c) => c.id === connectionId)?.availability ?? 'anywhere';
    if (availability === 'anywhere' || availability === machines?.self.id) return null;
    return machineName(machines, availability);
  };

  function handleSaved(profile: Profile): void {
    upsertProfile(profile);
    setEditingId(profile.id);
  }

  function handleDeleted(id: string): void {
    removeProfile(id);
    setEditingId(null);
  }

  return (
    <div className="mx-auto flex max-w-5xl gap-6">
      <div className="w-72 shrink-0">
        <button
          type="button"
          onClick={() => setEditingId('new')}
          disabled={connections.length === 0}
          title={connections.length === 0 ? 'Create a connection first.' : undefined}
          className="mb-3 w-full rounded bg-[var(--accent)] px-2 py-1.5 text-sm font-medium text-[var(--accent-text)] disabled:opacity-50"
        >
          + New profile
        </button>
        {profiles.length === 0 ? (
          <p className="text-sm text-[var(--text-faint)]">No profiles yet.</p>
        ) : (
          <ul data-testid="profiles-list" className="space-y-0.5">
            {profiles.map((p) => (
              <ProfileRow
                key={p.id}
                profile={p}
                connectionName={connectionName(p.connectionId)}
                onlyOn={onlyOn(p.connectionId)}
                active={p.id === editingId}
                onSelect={() => setEditingId(p.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex-1">
        {showForm ? (
          <ProfileForm
            key={editingId === 'new' ? 'new' : (selected?.id ?? 'new')}
            profile={editingId === 'new' ? null : selected}
            mcpServers={mcpServers}
            mcpServersFailed={mcpServersFailed}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <p className="text-sm text-[var(--text-faint)]">Select a profile to edit, or create a new one.</p>
        )}
      </div>
    </div>
  );
}
