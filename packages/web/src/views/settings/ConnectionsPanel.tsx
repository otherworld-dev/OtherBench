import { useEffect, useState, type JSX } from 'react';
import type { Connection, ConnectionKind } from '@otherbench/core/types/config.js';
import { ApiError, api, type CreateConnectionBody } from '../../state/api.js';
import { useOtherBenchStore } from '../../state/store.js';
import { isGenerationKind } from '@otherbench/core/domain/media.js';
import { WorkflowsSection } from './WorkflowsSection.js';

const CONNECTION_KINDS: readonly ConnectionKind[] = ['anthropic', 'openai', 'openai_compatible', 'google', 'ollama', 'claude_code', 'mock', 'comfyui', 'a1111', 'openai_images'];

/** Kinds shown under a name of their own (the rest show as their kind). */
const KIND_LABELS: Partial<Record<ConnectionKind, string>> = {
  comfyui: 'ComfyUI (recommended)',
  a1111: 'Automatic1111',
  openai_images: 'OpenAI-compatible images',
};

/** What the Base URL box suggests for a kind; the generation kinds are never auto-detected, so they show their usual address. */
const BASE_URL_PLACEHOLDERS: Partial<Record<ConnectionKind, string>> = {
  ollama: 'Defaults to http://127.0.0.1:11434',
  claude_code: 'Leave empty to use your Claude login',
  comfyui: 'http://127.0.0.1:8188',
  a1111: 'http://127.0.0.1:7860',
  openai_images: 'http://127.0.0.1:8080/v1',
};

const STATUS_COLOR: Record<Connection['status'], string> = {
  ok: 'bg-[var(--success)]',
  error: 'bg-[var(--danger)]',
  unknown: 'bg-[var(--text-faint)]',
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** One extra-header row while editing -- kept as key/value pairs client-side, collapsed to a `Record<string,string>` (dropping blank keys) only when the form actually submits. */
interface HeaderRow {
  key: string;
  value: string;
}

function headersToRows(headers: Record<string, string>): HeaderRow[] {
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}

function rowsToHeaders(rows: HeaderRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length > 0) result[key] = row.value;
  }
  return result;
}

interface ConnectionFormProps {
  /** `null` means "creating a new connection" -- every other prop behaves the same either way. */
  connection: Connection | null;
  onSaved: (connection: Connection) => void;
  onDeleted: (id: string) => void;
  onCancel: () => void;
}

/**
 * Add/edit form for one connection. Deliberately keyed by `connection?.id`
 * from the parent (see `ConnectionsPanel`) so switching the selected
 * connection -- or from an existing one to "new" -- remounts this component
 * with fresh local state, rather than trying to resync a pile of `useState`
 * via an effect.
 *
 * The API key is write-only (no GET ever returns it -- the server stores
 * only a `secretRef`, never the plaintext, see routes/connections.ts): this
 * form NEVER pre-fills `apiKeyDraft` from `connection`, only ever from what
 * the user just typed. Editing an existing connection shows whether a key
 * is currently set (from `connection.secretRef`, itself just a reference id,
 * not a secret) and offers two independent actions: type a new key to
 * replace it, or check "Clear" to remove it -- never both at once.
 */
function ConnectionForm({ connection, onSaved, onDeleted, onCancel }: ConnectionFormProps): JSX.Element {
  const [name, setName] = useState(connection?.name ?? '');
  const [kind, setKind] = useState<ConnectionKind>(connection?.kind ?? 'anthropic');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => headersToRows(connection?.extraHeaders ?? {}));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMessage, setDiscoverMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findMessage, setFindMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Where it works (v2 spec §5): left to the server (decided from the address) until changed here.
  const [availability, setAvailability] = useState<string | null>(connection?.availability ?? null);
  const [keepKeyHere, setKeepKeyHere] = useState(connection?.syncSecret === false);
  const [selfId, setSelfId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.node.get())
      .then((node) => {
        if (!cancelled) setSelfId(node.id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const upsertModels = useOtherBenchStore((s) => s.upsertModels);
  const models = useOtherBenchStore((s) => s.models);
  const profiles = useOtherBenchStore((s) => s.profiles);
  const chats = useOtherBenchStore((s) => s.chats);

  function validate(): string | null {
    if (name.trim().length === 0) return '"Name" is required.';
    // Mirrors the server's own check (requireBaseUrlIfOpenaiCompatible,
    // routes/connections.ts) client-side, so a user picking
    // "openai_compatible" without a base URL gets a useful message instead
    // of a round trip that comes back 400 -- see this task's brief.
    if (kind === 'openai_compatible' && baseUrl.trim().length === 0) {
      return 'A base URL is required for an OpenAI-compatible connection -- it has no default host to talk to.';
    }
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
      const body: CreateConnectionBody = {
        name: name.trim(),
        kind,
        baseUrl: baseUrl.trim().length > 0 ? baseUrl.trim() : null,
        extraHeaders: rowsToHeaders(headerRows),
      };
      if (keepKeyHere !== (connection?.syncSecret === false)) body.syncSecret = !keepKeyHere;
      if (availability !== null && availability !== (connection?.availability ?? null)) body.availability = availability;
      if (clearApiKey) body.apiKey = null;
      else if (apiKeyDraft.trim().length > 0) body.apiKey = apiKeyDraft;
      // else: omit `apiKey` entirely -- the existing key (if any) is left untouched.

      const saved = connection ? await api.connections.patch(connection.id, body) : await api.connections.create(body);
      setApiKeyDraft('');
      setClearApiKey(false);
      onSaved(saved);
    } catch (err) {
      console.error('[otherbench-web] failed to save connection:', err);
      setError(errorMessage(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    if (!connection) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.connections.test(connection.id);
      setTestResult(result);
    } catch (err) {
      console.error(`[otherbench-web] failed to test connection ${connection.id}:`, err);
      setTestResult({ ok: false, message: errorMessage(err, 'Test failed -- please try again.'), latencyMs: 0 });
    } finally {
      setTesting(false);
    }
  }

  async function handleFind(): Promise<void> {
    setFinding(true);
    setFindMessage(null);
    try {
      const found = await api.connections.findComfyui();
      if ('baseUrl' in found) {
        setBaseUrl(found.baseUrl);
        setFindMessage({ ok: true, text: `Found ComfyUI ${found.version} at ${found.baseUrl}` });
      } else {
        setFindMessage({ ok: false, text: "Couldn't find ComfyUI on this PC (tried 8188 and 8000). Is it running?" });
      }
    } catch (err) {
      console.error('[otherbench-web] failed to look for ComfyUI:', err);
      setFindMessage({ ok: false, text: errorMessage(err, 'Could not look for ComfyUI -- please try again.') });
    } finally {
      setFinding(false);
    }
  }

  async function handleDiscover(): Promise<void> {
    if (!connection) return;
    setDiscovering(true);
    setDiscoverMessage(null);
    try {
      const models = await api.connections.discoverModels(connection.id);
      upsertModels(models);
      setDiscoverMessage({ ok: true, text: `Discovered ${models.length} model${models.length === 1 ? '' : 's'} -- see the Models tab.` });
    } catch (err) {
      console.error(`[otherbench-web] failed to discover models for connection ${connection.id}:`, err);
      setDiscoverMessage({ ok: false, text: errorMessage(err, 'Discovery failed -- please try again.') });
    } finally {
      setDiscovering(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!connection) return;
    // The store already holds the exact counts a cascade delete would take
    // out (see removeConnection, state/store.ts, which mirrors the DB's own
    // ON DELETE CASCADE) -- putting the real numbers in THIS confirmation
    // is what makes it a decision the user can actually make, instead of
    // "any chat built on one of those profiles", which they'd have to
    // reconstruct in their head. No second confirmation step; the numbers
    // just go in the one that already exists.
    const dependentModelCount = models.filter((m) => m.connectionId === connection.id).length;
    const dependentProfileIds = new Set(profiles.filter((p) => p.connectionId === connection.id).map((p) => p.id));
    const dependentChatCount = chats.filter((c) => dependentProfileIds.has(c.profileId)).length;
    const parts = [
      `${dependentModelCount} model${dependentModelCount === 1 ? '' : 's'}`,
      `${dependentProfileIds.size} profile${dependentProfileIds.size === 1 ? '' : 's'}`,
    ];
    if (dependentChatCount > 0) {
      parts.push(
        `${dependentChatCount} chat${dependentChatCount === 1 ? '' : 's'} (including ${dependentChatCount === 1 ? 'its' : 'their'} message history)`
      );
    }
    const ok = window.confirm(`Delete connection "${connection.name}"? This also deletes ${parts.join(', ')}. This cannot be undone.`);
    if (!ok) return;
    setDeleting(true);
    setError(null);
    try {
      await api.connections.delete(connection.id);
      onDeleted(connection.id);
    } catch (err) {
      console.error(`[otherbench-web] failed to delete connection ${connection.id}:`, err);
      setError(errorMessage(err, 'Delete failed -- please try again.'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div data-testid="connection-form" className="max-w-xl space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="connection-name">
          Name
        </label>
        <input
          id="connection-name"
          aria-label="Connection name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="connection-kind">
          Kind
        </label>
        <select
          id="connection-kind"
          aria-label="Connection kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as ConnectionKind)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        >
          {CONNECTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k] ?? k}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="connection-base-url">
          Base URL
        </label>
        <input
          id="connection-base-url"
          aria-label="Base URL"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={BASE_URL_PLACEHOLDERS[kind] ?? 'https://api.example.com'}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
        />
        {kind === 'comfyui' && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void handleFind()} disabled={finding} className="btn px-2 py-1 text-xs">
              {finding ? 'Looking…' : 'Find ComfyUI'}
            </button>
            {findMessage && <span role="status" className={`text-xs ${findMessage.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{findMessage.text}</span>}
          </div>
        )}
        {kind === 'openai_compatible' && (
          <p className="mt-1 text-xs text-[var(--text-muted)]">Required -- an OpenAI-compatible connection has no default host to talk to.</p>
        )}
        {kind === 'claude_code' && (
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Runs turns through your local Claude Code. Empty uses your Claude login (no API key). An Anthropic-compatible endpoint such as
            Ollama&rsquo;s (http://localhost:11434) runs local models through Claude Code instead.
          </p>
        )}
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">API key</span>
        {connection && (
          <p data-testid="api-key-status" className="mb-1 text-xs text-[var(--text-muted)]">
            {connection.secretRef ? 'A key is currently set.' : 'No key is currently set.'}
          </p>
        )}
        <input
          type="password"
          aria-label={connection ? 'Replace API key' : 'API key'}
          value={apiKeyDraft}
          disabled={clearApiKey}
          onChange={(e) => setApiKeyDraft(e.target.value)}
          placeholder={connection ? 'Leave blank to keep the current key' : 'Optional'}
          autoComplete="new-password"
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm disabled:opacity-50"
        />
        {connection?.secretRef && (
          <label className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={clearApiKey}
              onChange={(e) => {
                setClearApiKey(e.target.checked);
                if (e.target.checked) setApiKeyDraft('');
              }}
            />
            Clear the stored API key
          </label>
        )}
        <label className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <input type="checkbox" checked={keepKeyHere} onChange={(e) => setKeepKeyHere(e.target.checked)} />
          Keep the API key on this machine (paired machines get the connection without it)
        </label>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]" htmlFor="connection-availability">
          Works on
        </label>
        <select
          id="connection-availability"
          aria-label="Works on"
          value={availability === null ? '' : availability === 'anywhere' ? 'anywhere' : availability === selfId ? 'here' : 'other'}
          onChange={(e) => {
            const v = e.target.value;
            setAvailability(v === 'anywhere' ? 'anywhere' : v === 'here' ? selfId : v === '' ? null : availability);
          }}
          className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1 text-sm"
        >
          {availability === null && <option value="">Decide from the address</option>}
          <option value="anywhere">Any machine</option>
          {selfId && <option value="here">Only this machine</option>}
          {availability !== null && availability !== 'anywhere' && availability !== selfId && <option value="other">Only another machine</option>}
        </select>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          A local address (localhost) only works on the machine it runs on; chats on other machines can't use this connection.
        </p>
      </div>

      <div>
        <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Extra headers</span>
        <div className="space-y-1.5">
          {headerRows.map((row, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                aria-label="Header name"
                value={row.key}
                onChange={(e) => setHeaderRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))}
                placeholder="Header-Name"
                className="w-1/2 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
              />
              <input
                aria-label="Header value"
                value={row.value}
                onChange={(e) => setHeaderRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r)))}
                placeholder="value"
                className="w-1/2 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
              />
              <button
                type="button"
                aria-label="Remove header"
                onClick={() => setHeaderRows((rows) => rows.filter((_, idx) => idx !== i))}
                className="shrink-0 rounded border border-[var(--border)] px-1.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setHeaderRows((rows) => [...rows, { key: '', value: '' }])}
            className="btn border-dashed text-[var(--text-muted)] px-2 py-1"
          >
            + Add header
          </button>
        </div>
      </div>

      {connection && connection.kind === 'comfyui' && kind === 'comfyui' && <WorkflowsSection connectionId={connection.id} baseUrl={connection.baseUrl || (BASE_URL_PLACEHOLDERS['comfyui'] ?? '')} />}

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
        {connection && (
          <>
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing}
              className="btn px-3 py-1.5"
            >
              {testing ? 'Testing…' : 'Test'}
            </button>
            {!isGenerationKind(connection.kind) && (
              <button
                type="button"
                onClick={() => void handleDiscover()}
                disabled={discovering}
                className="btn px-3 py-1.5"
              >
                {discovering ? 'Discovering…' : 'Discover models'}
              </button>
            )}
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

      {testResult && (
        <p data-testid="test-result" className={`text-sm ${testResult.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
          {testResult.message}
          {testResult.ok && ` (${testResult.latencyMs}ms)`}
        </p>
      )}
      {discoverMessage && (
        <p data-testid="discover-result" className={`text-sm ${discoverMessage.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
          {discoverMessage.text}
        </p>
      )}
    </div>
  );
}

function ConnectionRow({ connection, active, onSelect }: { connection: Connection; active: boolean; onSelect: () => void }): JSX.Element {
  return (
    <li>
      <button
        type="button"
        data-testid={`connection-row-${connection.id}`}
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
          active ? 'bg-[var(--bg-sunken)] shadow-[inset_2px_0_0_var(--accent)]' : 'hover:bg-[var(--bg-sunken)]'
        }`}
      >
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[connection.status]}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{connection.name}</span>
        <span className="shrink-0 text-xs text-[var(--text-muted)]">{connection.kind}</span>
      </button>
    </li>
  );
}

/**
 * Connections panel (task: settings UI, brief item 1). Add/edit/delete plus
 * Test and Discover models -- the single biggest usability gap this task
 * closes was that all three (connections, models, profiles) previously
 * required hand-rolled `curl` against the REST API.
 */
export function ConnectionsPanel(): JSX.Element {
  const connections = useOtherBenchStore((s) => s.connections);
  const upsertConnection = useOtherBenchStore((s) => s.upsertConnection);
  const removeConnection = useOtherBenchStore((s) => s.removeConnection);

  const [editingId, setEditingId] = useState<string | 'new' | null>(null);

  const selected = editingId && editingId !== 'new' ? (connections.find((c) => c.id === editingId) ?? null) : null;
  const showForm = editingId === 'new' || selected !== null;

  function handleSaved(connection: Connection): void {
    upsertConnection(connection);
    setEditingId(connection.id);
  }

  function handleDeleted(id: string): void {
    removeConnection(id);
    setEditingId(null);
  }

  return (
    <div className="mx-auto flex max-w-5xl gap-6">
      <div className="w-64 shrink-0">
        <button
          type="button"
          onClick={() => setEditingId('new')}
          className="btn btn-primary mb-3 w-full px-2 py-1.5"
        >
          + New connection
        </button>
        {connections.length === 0 ? (
          <p className="text-sm text-[var(--text-faint)]">No connections yet.</p>
        ) : (
          <ul data-testid="connections-list" className="space-y-0.5">
            {connections.map((c) => (
              <ConnectionRow key={c.id} connection={c} active={c.id === editingId} onSelect={() => setEditingId(c.id)} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex-1">
        {showForm ? (
          <ConnectionForm
            key={editingId === 'new' ? 'new' : (selected?.id ?? 'new')}
            connection={editingId === 'new' ? null : selected}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <p className="text-sm text-[var(--text-faint)]">Select a connection to edit, or create a new one.</p>
        )}
      </div>
    </div>
  );
}
