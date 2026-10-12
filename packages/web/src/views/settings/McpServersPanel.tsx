import { useEffect, useRef, useState, type JSX } from 'react';
import type { McpServer } from '@grunt/core/ports/store.js';
import type { McpServerHealth } from '@grunt/tools/mcp/manager.js';
import { usePolled } from '../../lib/usePolled.js';
import { ClaudeDesktopImport } from './ClaudeDesktopImport.js';
import { McpSignIn } from './McpSignIn.js';
import { ApiError, api, type CreateMcpServerBody } from '../../state/api.js';

const STATUS_COLOR: Record<McpServerHealth['status'], string> = {
  ok: 'bg-[var(--success)]',
  connecting: 'bg-[var(--accent)] animate-pulse',
  error: 'bg-[var(--danger)]',
  unknown: 'bg-[var(--text-faint)]',
  needs_auth: 'bg-[var(--warn)]',
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** One draft row for a key/value secret map (env vars or HTTP headers) while editing. */
interface KvRow {
  key: string;
  value: string;
  /**
   * The name this row was pre-seeded from by `keysToRows` (an existing
   * secret's name), or `null` for a brand-new row added via "+ Add". Stays
   * fixed while `key` changes as the user types, purely so a rename can be
   * detected -- see `blankRenamedRows`.
   */
  originalKey: string | null;
}

function keysToRows(keys: string[]): KvRow[] {
  return keys.map((key) => ({ key, value: '', originalKey: key }));
}

/**
 * Pre-seeded rows (`originalKey` set) whose key has been changed to a new,
 * non-blank name while the value is still blank. This is the case
 * `rowsToSecretPatch` cannot handle safely: the OLD name is absent from the
 * resulting patch (deleted server-side -- touching the field replaces the
 * whole set), and the NEW name isn't in `keepableNames` either (it never
 * existed under that name), so its blank value is dropped rather than kept.
 * Nothing ends up stored under EITHER name -- the secret is gone.
 *
 * There is no client-side way to carry the value across automatically: a
 * stored secret is never rendered back (see `McpServerForm`'s docstring),
 * so there is no plaintext here to re-send under the new name. Rather than
 * silently losing it, `validate()` refuses to save while any row is in
 * this state and tells the user to re-enter the value or remove the row --
 * the same "an ordinary edit must never silently destroy a secret"
 * discipline `rowsToSecretPatch`'s keep/drop split already applies to the
 * untouched-row case, extended to cover the renamed case it didn't.
 */
function blankRenamedRows(rows: KvRow[]): KvRow[] {
  return rows.filter((row) => {
    if (row.originalKey === null) return false;
    const key = row.key.trim();
    return key.length > 0 && key !== row.originalKey && row.value.length === 0;
  });
}

/**
 * Collapses draft rows into a `Record<string, string|null>` PATCH/create
 * payload. Drops a row with a blank key (same as
 * `ConnectionsPanel.rowsToHeaders`) -- an incomplete row is never sent.
 *
 * A row with a blank VALUE is handled two different ways depending on
 * where its NAME came from, and this distinction is the fix for a bug
 * where opening the editor and saving without changing anything silently
 * deleted every existing secret:
 *  - if its name is in `keepableNames` (an existing name `startEnvEdit`/
 *    `startHeaderEdit` pre-seeded this row from -- see `McpServerForm`'s
 *    docstring), the blank value means the user never actually typed into
 *    this row, so it is sent as an explicit KEEP (`null`) -- "leave
 *    whatever is already stored under this name untouched". Dropping it
 *    instead (the old behaviour) reads identically to the user having
 *    deleted the row, which is not what happened.
 *  - otherwise (a brand new row the user added via "+ Add" but never
 *    filled in) it is dropped, same as before: an unfinished new row isn't
 *    an intentional empty secret.
 *
 * `extraHeaders` (`ConnectionsPanel`'s equivalent) doesn't need any of this
 * -- it's plain non-secret metadata with no keep/replace distinction to
 * make, so an empty string there is just a legitimate value sent as-is.
 *
 * This function does NOT handle a pre-seeded row whose key was RENAMED
 * while its value stayed blank -- that combination is refused before save
 * ever calls this (`McpServerForm.validate`, via `blankRenamedRows`), since
 * neither the keep-by-name nor drop-when-new-and-empty rule above is safe
 * for it (see `blankRenamedRows`'s docstring for why).
 */
function rowsToSecretPatch(rows: KvRow[], keepableNames: ReadonlySet<string>): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    if (row.value.length === 0) {
      if (keepableNames.has(key)) result[key] = null;
      continue;
    }
    result[key] = row.value;
  }
  return result;
}

function argsToRows(args: string[]): string[] {
  return [...args];
}

function rowsToArgs(rows: string[]): string[] {
  return rows.map((r) => r.trim()).filter((r) => r.length > 0);
}

interface ParsedTool {
  name: string;
  description: string;
}

/**
 * `McpServer.toolsCache` is `unknown` on the wire (a JSON blob mirroring
 * `McpToolDescriptor[]`, packages/tools/src/mcp/client.ts, written by
 * `McpServerManager` only once a connection reaches `'ok'`) -- parsed
 * defensively here rather than cast, since it may be `null` (never
 * connected yet) or, in principle, a shape from a future/older server
 * version this client doesn't recognise.
 */
function parseToolsCache(toolsCache: unknown): ParsedTool[] {
  if (!Array.isArray(toolsCache)) return [];
  const result: ParsedTool[] = [];
  for (const entry of toolsCache) {
    if (typeof entry !== 'object' || entry === null) continue;
    const name = (entry as Record<string, unknown>)['name'];
    if (typeof name !== 'string') continue;
    const description = (entry as Record<string, unknown>)['description'];
    result.push({ name, description: typeof description === 'string' ? description : '' });
  }
  return result;
}

/** A key/value row editor shared by the env-vars and headers sections -- add/edit/remove rows, styled identically to `ConnectionsPanel`'s header-row editor. */
function KvRowsEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  keyLabel,
  valueLabel,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  keyLabel: string;
  valueLabel: string;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            aria-label={keyLabel}
            value={row.key}
            onChange={(e) => onChange(rows.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))}
            placeholder={keyPlaceholder}
            className="w-1/2 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
          />
          <input
            type="password"
            aria-label={valueLabel}
            value={row.value}
            onChange={(e) => onChange(rows.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))}
            placeholder={valuePlaceholder}
            autoComplete="new-password"
            className="w-1/2 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
          />
          <button
            type="button"
            aria-label={`Remove ${keyLabel.toLowerCase()}`}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            className="shrink-0 rounded border border-[var(--border)] px-1.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '', originalKey: null }])}
        className="btn border-dashed text-[var(--text-muted)] px-2 py-1"
      >
        + Add {keyLabel.toLowerCase()}
      </button>
    </div>
  );
}

interface McpServerFormProps {
  /** `null` means "creating a new server". */
  server: McpServer | null;
  /** The selected server's live health from the panel's poll (null while loading, or for a new server). */
  health: McpServerHealth | null;
  /** Asks the panel to re-poll after a sign-in action. */
  onSignInChanged: () => void;
  onSaved: (server: McpServer) => void;
  onDeleted: (id: string) => void;
  onCancel: () => void;
}

/**
 * Add/edit form for one MCP server. Keyed by `server?.id` from the parent
 * (see `McpServersPanel`) so switching servers remounts with fresh state,
 * matching `ConnectionForm`/`ProfileForm`.
 *
 * `env` (stdio) and `headers` (http) are BOTH stored server-side as
 * `SecretStore` references (`McpServer.envRefs`/`headerRefs`) and never
 * echoed back as plaintext (see routes/tools.ts) -- exactly the write-only
 * discipline `ConnectionForm` already applies to a connection's API key,
 * generalised here from a single value to a named set: the form shows WHICH
 * NAMES are currently set (safe metadata, not a secret) but never their
 * values, and a name typed into "current names" pre-seeds an empty row
 * purely as a convenience so re-adding a variable doesn't require retyping
 * its name too. Leaving the whole section untouched (never clicking
 * "Edit...") omits it from the PATCH body entirely (existing secrets stay
 * exactly as they are).
 *
 * Touching it DOES replace the complete set of names -- a row removed via
 * its "✕" (or the whole section cleared) is genuinely deleted -- but a
 * pre-seeded row the user never typed a value into is NOT treated as
 * deleted: its blank value means "unedited", and `rowsToSecretPatch` sends
 * an explicit keep (`null`) for it rather than dropping it, which is what
 * `PATCH /mcp-servers/:id` (`applySecretPatch`, routes/tools.ts) needs to
 * carry that name's existing secret over untouched. Without this, opening
 * "Edit environment variables…" and clicking Save without changing
 * anything silently deleted every existing env var/header -- a pre-seeded
 * row's blank value looked identical to "the user wants this empty" and
 * was dropped the same way an unfinished new row is.
 */
function McpServerForm({ server, health, onSignInChanged, onSaved, onDeleted, onCancel }: McpServerFormProps): JSX.Element {
  const [name, setName] = useState(server?.name ?? '');
  const [transport, setTransport] = useState<McpServer['transport']>(server?.transport ?? 'stdio');
  const [command, setCommand] = useState(server?.command ?? '');
  const [argRows, setArgRows] = useState<string[]>(() => argsToRows(server?.args ?? []));
  const [url, setUrl] = useState(server?.url ?? '');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);

  const [envRows, setEnvRows] = useState<KvRow[]>([]);
  const [envTouched, setEnvTouched] = useState(false);
  const [envClear, setEnvClear] = useState(false);
  const [headerRows, setHeaderRows] = useState<KvRow[]>([]);
  const [headerTouched, setHeaderTouched] = useState(false);
  const [headerClear, setHeaderClear] = useState(false);

  const [oauthClientId, setOauthClientId] = useState(server?.oauth?.clientId ?? '');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [removeClientSecret, setRemoveClientSecret] = useState(false);
  const [redirectUri, setRedirectUri] = useState<string | null>(null);

  useEffect(() => {
    if (transport !== 'http') return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.mcpServers.signInRedirectUri())
      .then((r) => {
        if (!cancelled) setRedirectUri(r.redirectUri);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [transport]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  const tools = parseToolsCache(server?.toolsCache ?? null);

  function startEnvEdit(): void {
    setEnvRows((rows) => (rows.length > 0 ? rows : keysToRows(Object.keys(server?.envRefs ?? {}))));
    setEnvTouched(true);
    setEnvClear(false);
  }
  function startHeaderEdit(): void {
    setHeaderRows((rows) => (rows.length > 0 ? rows : keysToRows(Object.keys(server?.headerRefs ?? {}))));
    setHeaderTouched(true);
    setHeaderClear(false);
  }

  /**
   * A rename-left-blank error message for the first offending row (see
   * `blankRenamedRows`), or `null` if `rows` has none. `label` is "env var"
   * / "header" purely for wording.
   */
  function renamedRowError(rows: KvRow[], label: string): string | null {
    const offender = blankRenamedRows(rows)[0];
    if (!offender) return null;
    return (
      `"${offender.originalKey}" was renamed to "${offender.key.trim()}" but its ${label} value is still blank -- ` +
      `re-enter the value for "${offender.key.trim()}", or remove the row (✕) to delete "${offender.originalKey}".`
    );
  }

  function validate(): string | null {
    if (name.trim().length === 0) return '"Name" is required.';
    if (transport === 'stdio' && command.trim().length === 0) return 'A command is required for a stdio server.';
    if (transport === 'http' && url.trim().length === 0) return 'A URL is required for an http (Streamable HTTP) server.';
    if (transport === 'stdio' && envTouched && !envClear) {
      const err = renamedRowError(envRows, 'env var');
      if (err) return err;
    }
    if (transport === 'http' && headerTouched && !headerClear) {
      const err = renamedRowError(headerRows, 'header');
      if (err) return err;
    }
    if (transport === 'http' && oauthClientSecret.length > 0 && oauthClientId.trim().length === 0) return 'Enter the client ID the secret belongs to.';
    return null;
  }

  async function handleSave(): Promise<void> {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body: CreateMcpServerBody = {
        name: name.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() : null,
        args: transport === 'stdio' ? rowsToArgs(argRows) : [],
        url: transport === 'http' ? url.trim() : null,
        enabled,
      };
      if (transport === 'stdio') {
        if (envClear) body.env = {};
        else if (envTouched) body.env = rowsToSecretPatch(envRows, new Set(Object.keys(server?.envRefs ?? {})));
        // else: omit -- existing env vars (if any) are left untouched.
      }
      if (transport === 'http') {
        if (headerClear) body.headers = {};
        else if (headerTouched) body.headers = rowsToSecretPatch(headerRows, new Set(Object.keys(server?.headerRefs ?? {})));
        // else: omit -- existing headers (if any) are left untouched.
        const clientId = oauthClientId.trim();
        if (clientId !== (server?.oauth?.clientId ?? '')) body.oauthClientId = clientId === '' ? null : clientId;
        if (oauthClientSecret.length > 0) body.oauthClientSecret = oauthClientSecret;
        else if (removeClientSecret) body.oauthClientSecret = null;
      }

      const saved = server ? await api.mcpServers.patch(server.id, body) : await api.mcpServers.create(body);
      // The form stays mounted after a save: a typed client secret must not linger in state (or be re-sent by the next save).
      setOauthClientSecret('');
      setRemoveClientSecret(false);
      onSaved(saved);
    } catch (err) {
      console.error('[grunt-web] failed to save MCP server:', err);
      setError(errorMessage(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!server) return;
    const ok = window.confirm(`Delete MCP server "${server.name}"? Any profile that enables it loses access to its tools. This cannot be undone.`);
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      await api.mcpServers.delete(server.id);
      onDeleted(server.id);
    } catch (err) {
      console.error(`[grunt-web] failed to delete MCP server ${server.id}:`, err);
      setError(errorMessage(err, 'Delete failed -- please try again.'));
    } finally {
      setDeleting(false);
    }
  }

  async function handleRefresh(): Promise<void> {
    if (!server) return;
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      await api.mcpServers.refresh(server.id);
      setRefreshMessage('Refresh requested -- see status in the list on the left.');
    } catch (err) {
      console.error(`[grunt-web] failed to refresh MCP server ${server.id}:`, err);
      setRefreshMessage(errorMessage(err, 'Refresh failed -- please try again.'));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div data-testid="mcp-server-form" className="max-w-xl space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="mcp-name">
          Name
        </label>
        <input
          id="mcp-name"
          aria-label="MCP server name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="mcp-transport">
          Transport
        </label>
        <select
          id="mcp-transport"
          aria-label="Transport"
          value={transport}
          onChange={(e) => setTransport(e.target.value as McpServer['transport'])}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        >
          <option value="stdio">stdio -- launches a local process</option>
          <option value="http">http -- Streamable HTTP</option>
        </select>
      </div>

      {transport === 'stdio' ? (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="mcp-command">
              Command
            </label>
            <input
              id="mcp-command"
              aria-label="Command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
            />
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Arguments</span>
            <div className="space-y-1.5">
              {argRows.map((arg, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    aria-label="Argument"
                    value={arg}
                    onChange={(e) => setArgRows((rows) => rows.map((r, idx) => (idx === i ? e.target.value : r)))}
                    placeholder="-y @some/mcp-server"
                    className="flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    aria-label="Remove argument"
                    onClick={() => setArgRows((rows) => rows.filter((_, idx) => idx !== i))}
                    className="shrink-0 rounded border border-[var(--border)] px-1.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setArgRows((rows) => [...rows, ''])}
                className="btn border-dashed text-[var(--text-muted)] px-2 py-1"
              >
                + Add argument
              </button>
            </div>
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Environment variables</span>
            {server && !envTouched && !envClear && (
              <p data-testid="mcp-env-status" className="mb-1.5 text-xs text-[var(--text-muted)]">
                {Object.keys(server.envRefs).length > 0 ? `Currently set: ${Object.keys(server.envRefs).join(', ')}. Values are never shown.` : 'None set.'}
              </p>
            )}
            {envTouched ? (
              <>
                <p className="mb-1.5 text-xs text-[var(--text-muted)]">
                  A blank value is left unchanged from before -- but only under the SAME name: renaming a row also
                  requires re-entering its value, since a stored value is never shown back here to carry over.
                  Remove a row (✕) to delete it.
                </p>
                <KvRowsEditor rows={envRows} onChange={setEnvRows} keyPlaceholder="API_KEY" valuePlaceholder="value" keyLabel="Env var name" valueLabel="Env var value" />
              </>
            ) : (
              <button type="button" onClick={startEnvEdit} disabled={envClear} className="btn px-2 py-1">
                Edit environment variables…
              </button>
            )}
            {server && Object.keys(server.envRefs).length > 0 && (
              <label className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                <input
                  type="checkbox"
                  checked={envClear}
                  onChange={(e) => {
                    setEnvClear(e.target.checked);
                    if (e.target.checked) {
                      setEnvTouched(false);
                      setEnvRows([]);
                    }
                  }}
                />
                Clear all environment variables
              </label>
            )}
          </div>
        </>
      ) : (
        <>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="mcp-url">
              URL
            </label>
            <input
              id="mcp-url"
              aria-label="URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
            />
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Headers</span>
            {server && !headerTouched && !headerClear && (
              <p data-testid="mcp-headers-status" className="mb-1.5 text-xs text-[var(--text-muted)]">
                {Object.keys(server.headerRefs).length > 0 ? `Currently set: ${Object.keys(server.headerRefs).join(', ')}. Values are never shown.` : 'None set.'}
              </p>
            )}
            {headerTouched ? (
              <>
                <p className="mb-1.5 text-xs text-[var(--text-muted)]">
                  A blank value is left unchanged from before -- but only under the SAME name: renaming a row also
                  requires re-entering its value, since a stored value is never shown back here to carry over.
                  Remove a row (✕) to delete it.
                </p>
                <KvRowsEditor
                  rows={headerRows}
                  onChange={setHeaderRows}
                  keyPlaceholder="Authorization"
                  valuePlaceholder="Bearer …"
                  keyLabel="Header name"
                  valueLabel="Header value"
                />
              </>
            ) : (
              <button
                type="button"
                onClick={startHeaderEdit}
                disabled={headerClear}
                className="btn px-2 py-1"
              >
                Edit headers…
              </button>
            )}
            {server && Object.keys(server.headerRefs).length > 0 && (
              <label className="mt-1.5 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                <input
                  type="checkbox"
                  checked={headerClear}
                  onChange={(e) => {
                    setHeaderClear(e.target.checked);
                    if (e.target.checked) {
                      setHeaderTouched(false);
                      setHeaderRows([]);
                    }
                  }}
                />
                Clear all headers
              </label>
            )}
          </div>

          {server && server.transport === 'http' ? (
            <McpSignIn server={server} health={health} onChanged={onSignInChanged} />
          ) : (
            <p className="text-xs text-[var(--text-muted)]">Save the server first; then you can sign in.</p>
          )}

          <details data-testid="mcp-sign-in-app" className="rounded border border-[var(--border)] px-2 py-1.5">
            <summary className="cursor-pointer text-xs font-medium text-[var(--text-muted)]">Sign-in app</summary>
            <p className="mt-1.5 text-xs text-[var(--text-muted)]">
              {`Only needed when the server's sign-in provider can't register Grunt itself. Register Grunt there with the redirect address ${redirectUri ?? 'http://127.0.0.1:<port>/oauth/callback'}. The provider must allow any port: the desktop app's port changes each launch.`}
            </p>
            <div className="mt-1.5 space-y-1.5">
              <input
                aria-label="Client ID"
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                placeholder="Client ID"
                className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
              />
              {server?.oauth?.clientSecretRef && !removeClientSecret && oauthClientSecret.length === 0 && (
                <p className="text-xs text-[var(--text-muted)]">
                  A client secret is set.{' '}
                  <button type="button" onClick={() => setRemoveClientSecret(true)} className="btn px-1.5 py-0.5">
                    Remove
                  </button>
                </p>
              )}
              <input
                type="password"
                aria-label="Client secret"
                value={oauthClientSecret}
                onChange={(e) => setOauthClientSecret(e.target.value)}
                placeholder="Client secret (optional)"
                autoComplete="new-password"
                className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
              />
            </div>
          </details>
        </>
      )}

      <label className="flex items-center gap-1.5 text-sm">
        <input type="checkbox" aria-label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      {server && (
        <div>
          <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Tools this server exposes</span>
          {tools.length === 0 ? (
            <p className="text-xs text-[var(--text-faint)]">No tools listed yet -- connect the server (enable it, or click Refresh) to discover them.</p>
          ) : (
            <ul data-testid="mcp-tools-list" className="space-y-1">
              {tools.map((t) => (
                <li key={t.name} className="text-xs">
                  <span className="font-mono font-medium">{t.name}</span>
                  {t.description && <span className="text-[var(--text-muted)]"> -- {t.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="btn btn-primary px-3 py-1.5"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="btn px-3 py-1.5">
          Cancel
        </button>
        {server && (
          <>
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="btn px-3 py-1.5"
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="btn btn-danger ml-auto px-3 py-1.5"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </>
        )}
      </div>

      {refreshMessage && (
        <p data-testid="mcp-refresh-result" className="text-sm text-[var(--text-muted)]">
          {refreshMessage}
        </p>
      )}
    </div>
  );
}

function McpServerRow({
  health,
  active,
  busy,
  onSelect,
  onToggleEnabled,
  onRefresh,
}: {
  health: McpServerHealth;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onToggleEnabled: () => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <li>
      <div className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${active ? 'bg-[var(--bg-sunken)] shadow-[inset_2px_0_0_var(--accent)]' : 'hover:bg-[var(--bg-sunken)]'}`}>
        <button
          type="button"
          data-testid={`mcp-row-${health.id}`}
          onClick={onSelect}
          aria-current={active ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[health.status]}`} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{health.name}</span>
          <span className="shrink-0 text-xs text-[var(--text-muted)]">
            {health.transport} · {!health.enabled ? 'disabled' : health.status === 'needs_auth' ? 'needs sign-in' : `${health.toolCount} tool${health.toolCount === 1 ? '' : 's'}`}
          </span>
        </button>
        <button
          type="button"
          aria-label={health.enabled ? `Disable ${health.name}` : `Enable ${health.name}`}
          disabled={busy}
          onClick={onToggleEnabled}
          className="btn shrink-0 px-1.5 py-0.5"
        >
          {health.enabled ? 'On' : 'Off'}
        </button>
        <button
          type="button"
          aria-label={`Refresh ${health.name}`}
          disabled={busy}
          onClick={onRefresh}
          className="shrink-0 rounded-sm border border-[var(--border-strong)] px-1.5 py-0.5 text-xs hover:bg-[var(--bg-sunken)] disabled:opacity-50"
        >
          ↻
        </button>
      </div>
      {health.status === 'error' && health.lastError && (
        <p className="truncate px-2 pb-1 text-xs text-[var(--danger)]" title={health.lastError}>
          {health.lastError}
        </p>
      )}
    </li>
  );
}

/**
 * MCP servers panel (settings UI, remaining piece 1). Add/edit/delete,
 * enable/disable, and a manual refresh -- the previous agent's Connections/
 * Models/Profiles panels were built before there was any way to manage MCP
 * servers, so `Profile.toolPolicy.mcpServerIds` (this panel's sibling in
 * ProfilesPanel) had nothing to select from.
 *
 * `list()` (`GET /mcp-servers`, polled here every few seconds like
 * Inspector's own health section) returns live health only -- status, tool
 * COUNT, enabled -- so the row list is built from that directly. The edit
 * form needs the full stored config (command/args/url/env/headers), which
 * has no place in the health shape, so selecting a row fetches it separately
 * via `GET /mcp-servers/:id`. `pollNonce` forces `usePolled` to restart (and
 * therefore re-fetch immediately, not waiting out the rest of the interval)
 * right after any action this panel itself performs -- create, delete,
 * enable/disable, refresh -- so those actions are reflected in the list
 * without a several-second-long "did that work?" gap.
 */
export function McpServersPanel(): JSX.Element {
  const [pollNonce, setPollNonce] = useState(0);
  const { data: servers, failed: healthFailed } = usePolled(() => api.mcpServers.list(), [pollNonce]);
  const bumpPoll = (): void => setPollNonce((n) => n + 1);

  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState<McpServer | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  // Set right before `handleSaved` switches `editingId` to a just-created/
  // -saved server's own id -- that id's full config is already in hand (the
  // create/patch response IS the full McpServer), so the effect below must
  // skip its own fetch for that one transition rather than immediately
  // re-requesting via GET the exact object it was just handed, which would
  // also flash the form to "Loading…" right after a successful save.
  const skipNextFetch = useRef(false);

  useEffect(() => {
    if (!editingId || editingId === 'new') {
      setSelectedConfig(null);
      setLoadError(null);
      return;
    }
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    let cancelled = false;
    setLoadingConfig(true);
    setLoadError(null);
    api.mcpServers
      .get(editingId)
      .then((cfg) => {
        if (!cancelled) setSelectedConfig(cfg);
      })
      .catch((err: unknown) => {
        console.error(`[grunt-web] failed to load MCP server ${editingId}:`, err);
        if (!cancelled) setLoadError(errorMessage(err, 'Failed to load this server -- please try again.'));
      })
      .finally(() => {
        if (!cancelled) setLoadingConfig(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingId]);

  function handleSaved(server: McpServer): void {
    // Only meaningful (and only consumed) when `editingId` is genuinely
    // about to change, e.g. 'new' -> the freshly created id -- that's the
    // one case the effect below will actually re-run for. Patching an
    // ALREADY-selected server leaves `editingId` unchanged, so the effect
    // never re-runs and never gets a chance to consume the flag; setting it
    // in that case would wrongly skip the fetch for whatever the user
    // selects next.
    if (editingId !== server.id) skipNextFetch.current = true;
    setSelectedConfig(server);
    setEditingId(server.id);
    bumpPoll();
  }

  function handleDeleted(): void {
    setEditingId(null);
    setSelectedConfig(null);
    bumpPoll();
  }

  async function toggleEnabled(health: McpServerHealth): Promise<void> {
    setBusyIds((s) => new Set(s).add(health.id));
    try {
      await api.mcpServers.patch(health.id, { enabled: !health.enabled });
      bumpPoll();
    } catch (err) {
      console.error(`[grunt-web] failed to toggle MCP server ${health.id}:`, err);
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(health.id);
        return next;
      });
    }
  }

  async function refreshOne(health: McpServerHealth): Promise<void> {
    setBusyIds((s) => new Set(s).add(health.id));
    try {
      await api.mcpServers.refresh(health.id);
      bumpPoll();
    } catch (err) {
      console.error(`[grunt-web] failed to refresh MCP server ${health.id}:`, err);
    } finally {
      setBusyIds((s) => {
        const next = new Set(s);
        next.delete(health.id);
        return next;
      });
    }
  }

  const showForm = editingId === 'new' || selectedConfig !== null;

  return (
    <div className="mx-auto flex max-w-5xl gap-6">
      <div className="w-80 shrink-0">
        <button
          type="button"
          onClick={() => {
            setImporting(false);
            setEditingId('new');
          }}
          className="btn btn-primary mb-2 w-full px-2 py-1.5"
        >
          + New MCP server
        </button>
        <button
          type="button"
          onClick={() => {
            setEditingId(null);
            setImporting(true);
          }}
          className="btn mb-3 w-full px-2 py-1.5"
        >
          Import from Claude Desktop…
        </button>
        {healthFailed && <p className="mb-2 text-xs text-[var(--danger)]">Couldn&rsquo;t load MCP server health.</p>}
        {servers === null ? (
          <p className="text-sm text-[var(--text-faint)]">Loading…</p>
        ) : servers.length === 0 ? (
          <p className="text-sm text-[var(--text-faint)]">No MCP servers yet.</p>
        ) : (
          <ul data-testid="mcp-servers-list" className="space-y-0.5">
            {servers.map((h) => (
              <McpServerRow
                key={h.id}
                health={h}
                active={h.id === editingId}
                busy={busyIds.has(h.id)}
                onSelect={() => {
                  setImporting(false);
                  setEditingId(h.id);
                }}
                onToggleEnabled={() => void toggleEnabled(h)}
                onRefresh={() => void refreshOne(h)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex-1">
        {importing ? (
          <ClaudeDesktopImport onImported={bumpPoll} onClose={() => setImporting(false)} />
        ) : editingId === 'new' ? (
          <McpServerForm key="new" server={null} health={null} onSignInChanged={bumpPoll} onSaved={handleSaved} onDeleted={handleDeleted} onCancel={() => setEditingId(null)} />
        ) : editingId && loadingConfig ? (
          <p className="text-sm text-[var(--text-faint)]">Loading…</p>
        ) : editingId && loadError ? (
          <p className="text-sm text-[var(--danger)]">{loadError}</p>
        ) : showForm && selectedConfig ? (
          <McpServerForm
            key={selectedConfig.id}
            server={selectedConfig}
            health={servers?.find((h) => h.id === selectedConfig.id) ?? null}
            onSignInChanged={bumpPoll}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <p className="text-sm text-[var(--text-faint)]">Select a server to edit, or create a new one.</p>
        )}
      </div>
    </div>
  );
}
