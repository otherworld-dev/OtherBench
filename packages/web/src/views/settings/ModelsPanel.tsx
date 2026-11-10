import { useMemo, useState, type JSX } from 'react';
import type { ModelInfo } from '@otherbench/core/types/config.js';
import { ApiError, api } from '../../state/api.js';
import { useOtherBenchStore } from '../../state/store.js';
import { matchesSearch, newModelIds, sortModels, type Sort, type SortKey } from './model-table.js';

interface Draft {
  displayName: string;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
  contextWindow: string;
  maxOutput: string;
  priceInPer1m: string;
  priceOutPer1m: string;
  priceCachedPer1m: string;
  currency: string;
}

function draftFor(model: ModelInfo): Draft {
  return {
    displayName: model.displayName,
    supportsVision: model.supportsVision,
    supportsTools: model.supportsTools,
    supportsReasoning: model.supportsReasoning,
    contextWindow: model.contextWindow?.toString() ?? '',
    maxOutput: model.maxOutput?.toString() ?? '',
    priceInPer1m: model.priceInPer1m?.toString() ?? '',
    priceOutPer1m: model.priceOutPer1m?.toString() ?? '',
    priceCachedPer1m: model.priceCachedPer1m?.toString() ?? '',
    currency: model.currency,
  };
}

/** `''` (a field left/cleared blank) means "unknown" and parses to `null`; anything else must be a real number or the save is rejected -- see this task's brief: blank and zero are NOT the same thing (local models are genuinely free at $0, not "unpriced"). */
function parseOptionalNumber(raw: string): number | null | undefined {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined; // undefined signals "invalid, don't submit"
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

interface ModelEditorProps {
  model: ModelInfo;
  onSaved: (updated: ModelInfo) => void;
}

/**
 * One model's edit form, opened under its line in the table. Discovery (`POST /connections/:id/discover-models`,
 * driven from the Connections panel's "Discover models" button) declares
 * capability flags conservatively (`false`/unknown) for most connection
 * kinds -- OtherBench has no reliable handshake for "do you accept images"
 * against an arbitrary endpoint. Ollama is the one exception: its native
 * API genuinely reports per-model capabilities, so discovery seeds real
 * `true`/`false` values for it (`AiSdkChatEngine.seedOllamaCapabilities`,
 * packages/engine-aisdk/src/engine.ts). Either way, saving an edit here
 * (`PATCH /models/:id`) marks the row `source: 'manual'` server-side, so a
 * later re-discovery can never silently overwrite what a human just
 * declared -- see the promotion in routes/models.ts. Leaving
 * `supportsVision` off for a model that actually accepts images means an
 * attached image silently degrades to text for any profile using it
 * (`degradedAttachmentsNotice`, packages/core/src/domain/turn.ts) -- the
 * explanatory copy below exists specifically so that isn't a surprise.
 */
function ModelEditor({ model, onSaved }: ModelEditorProps): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftFor(model));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(): Promise<void> {
    const contextWindow = parseOptionalNumber(draft.contextWindow);
    const maxOutput = parseOptionalNumber(draft.maxOutput);
    const priceInPer1m = parseOptionalNumber(draft.priceInPer1m);
    const priceOutPer1m = parseOptionalNumber(draft.priceOutPer1m);
    const priceCachedPer1m = parseOptionalNumber(draft.priceCachedPer1m);
    if ([contextWindow, maxOutput, priceInPer1m, priceOutPer1m, priceCachedPer1m].some((v) => v === undefined)) {
      setError('Numeric fields must be numbers, or left blank for "unknown".');
      return;
    }
    if (draft.displayName.trim().length === 0) {
      setError('"Display name" is required.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const updated = await api.models.patch(model.id, {
        displayName: draft.displayName.trim(),
        supportsVision: draft.supportsVision,
        supportsTools: draft.supportsTools,
        supportsReasoning: draft.supportsReasoning,
        contextWindow,
        maxOutput,
        priceInPer1m,
        priceOutPer1m,
        priceCachedPer1m,
        currency: draft.currency.trim() || 'USD',
      });
      onSaved(updated);
    } catch (err) {
      console.error(`[otherbench-web] failed to save model ${model.id}:`, err);
      setError(errorMessage(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="py-2">
      <div className="mb-2 text-xs text-[var(--text-muted)]">{model.source === 'manual' ? 'Managed by hand' : 'Found by Discover models'}</div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--text-muted)] sm:col-span-4">
          Display name
          <input
            aria-label={`${model.modelId} display name`}
            value={draft.displayName}
            onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
          />
        </label>

        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            aria-label={`${model.modelId} supports vision`}
            checked={draft.supportsVision}
            onChange={(e) => setDraft((d) => ({ ...d, supportsVision: e.target.checked }))}
          />
          Vision
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            aria-label={`${model.modelId} supports tools`}
            checked={draft.supportsTools}
            onChange={(e) => setDraft((d) => ({ ...d, supportsTools: e.target.checked }))}
          />
          Tools
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            aria-label={`${model.modelId} supports reasoning`}
            checked={draft.supportsReasoning}
            onChange={(e) => setDraft((d) => ({ ...d, supportsReasoning: e.target.checked }))}
          />
          Reasoning
        </label>
        <div />

        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Context window
          <input
            aria-label={`${model.modelId} context window`}
            value={draft.contextWindow}
            onChange={(e) => setDraft((d) => ({ ...d, contextWindow: e.target.value }))}
            placeholder="—"
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Max output
          <input
            aria-label={`${model.modelId} max output`}
            value={draft.maxOutput}
            onChange={(e) => setDraft((d) => ({ ...d, maxOutput: e.target.value }))}
            placeholder="—"
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Currency
          <input
            aria-label={`${model.modelId} currency`}
            value={draft.currency}
            onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
          />
        </label>
        <div />

        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Price in / 1M
          <input
            aria-label={`${model.modelId} price in per 1M tokens`}
            value={draft.priceInPer1m}
            onChange={(e) => setDraft((d) => ({ ...d, priceInPer1m: e.target.value }))}
            placeholder="—"
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Price out / 1M
          <input
            aria-label={`${model.modelId} price out per 1M tokens`}
            value={draft.priceOutPer1m}
            onChange={(e) => setDraft((d) => ({ ...d, priceOutPer1m: e.target.value }))}
            placeholder="—"
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          Cached price / 1M
          <input
            aria-label={`${model.modelId} cached price per 1M tokens`}
            value={draft.priceCachedPer1m}
            onChange={(e) => setDraft((d) => ({ ...d, priceCachedPer1m: e.target.value }))}
            placeholder="—"
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm text-[var(--text)]"
          />
        </label>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="btn btn-primary px-2.5 py-1"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      </div>
    </div>
  );
}

function formatPrice(model: ModelInfo): string {
  if (model.priceInPer1m === null && model.priceOutPer1m === null) return '—';
  const one = (n: number | null): string => (n === null ? '—' : String(n));
  return `${one(model.priceInPer1m)} / ${one(model.priceOutPer1m)} ${model.currency}`;
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'connection', label: 'Connection' },
  { key: 'vision', label: 'Vision' },
  { key: 'tools', label: 'Tools' },
  { key: 'price', label: 'Price in / out per 1M' },
];

function Capability({ name, label, on }: { name: string; label: string; on: boolean }): JSX.Element {
  return (
    <span role="img" aria-label={`${name} ${label}: ${on ? 'yes' : 'no'}`} className={on ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}>
      {on ? '✓' : '✗'}
    </span>
  );
}

/**
 * Models panel (task: settings UI, brief item 2). Per connection, lists
 * every discovered (or manually added) model and lets the user edit what
 * OtherBench cannot reliably detect on its own: capability flags, context/output
 * limits, and pricing. Reuses the global `models`/`connections` store, so a
 * "Discover models" run from the Connections panel is already reflected
 * here without a refetch. One table line per model, searchable and sortable
 * (model-table.ts); clicking a line opens its edit form under it, one at a
 * time, and the models the latest Discover added carry a "New" tag.
 */
export function ModelsPanel(): JSX.Element {
  const connections = useOtherBenchStore((s) => s.connections);
  const models = useOtherBenchStore((s) => s.models);
  const upsertModel = useOtherBenchStore((s) => s.upsertModel);

  const [connectionFilter, setConnectionFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'connection', dir: 'asc' });
  const [openId, setOpenId] = useState<string | null>(null);

  const connectionName = (id: string): string => connections.find((c) => c.id === id)?.name ?? 'Unknown connection';
  const inConnection = connectionFilter === 'all' ? models : models.filter((m) => m.connectionId === connectionFilter);
  const fresh = useMemo(() => newModelIds(models), [models]);
  const visible = sortModels(
    inConnection.filter((m) => matchesSearch(m, search)),
    sort,
    connectionName
  );

  function sortBy(key: SortKey): void {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Capabilities are declared, not probed, for most connections -- a custom endpoint can claim to be anything, and there is no reliable
        handshake to check what it actually accepts. Ollama is the one exception: its native API reports real per-model capabilities, so
        discovery seeds genuine values there. Either way, saving an edit below marks that row as manually managed, so a later &ldquo;Discover
        models&rdquo; run can never silently overwrite what you just set. Leave &ldquo;Vision&rdquo; off and an attached image silently
        degrades to text for any profile using this model; leave &ldquo;Tools&rdquo; off and tool calls are never offered to it. A blank price
        means unknown (shown as &ldquo;—&rdquo; elsewhere) -- zero means genuinely free, which is normal for a local model.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          aria-label="Search models"
          placeholder="Search models…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
        />
        <label className="text-xs text-[var(--text-muted)]" htmlFor="models-connection-filter">
          Connection
        </label>
        <select
          id="models-connection-filter"
          aria-label="Filter by connection"
          value={connectionFilter}
          onChange={(e) => setConnectionFilter(e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
        >
          <option value="all">All connections</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {inConnection.length === 0 ? (
        <p className="text-sm text-[var(--text-faint)]">
          No models yet -- discover them from a connection&rsquo;s Test/Discover models buttons in the Connections tab.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-[var(--text-faint)]">No models match &ldquo;{search.trim()}&rdquo;.</p>
      ) : (
        <table className="w-full table-fixed text-sm" data-testid="models-list">
          <thead className="sticky top-0 bg-[var(--bg)]">
            <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  aria-sort={sort.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={`pb-1 font-medium ${col.key === 'name' ? 'w-[45%]' : ''}`}
                >
                  <button type="button" onClick={() => sortBy(col.key)} className="hover:text-[var(--text)]">
                    {col.label}
                    {sort.key === col.key && <span aria-hidden="true">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => {
              const open = openId === m.id;
              return [
                // The whole line opens the form; the name is a button so the keyboard can too (its click bubbles here).
                <tr
                  key={m.id}
                  data-testid={`model-row-${m.id}`}
                  onClick={() => setOpenId(open ? null : m.id)}
                  className={`cursor-pointer border-b border-[var(--border)] hover:bg-[var(--bg-sunken)] ${open ? 'bg-[var(--bg-sunken)]' : ''}`}
                >
                  <td className="py-1.5 pr-2">
                    <button type="button" aria-expanded={open} className="block w-full min-w-0 text-left">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{m.displayName}</span>
                        {fresh.has(m.id) && (
                          <span className="shrink-0 rounded-full bg-[var(--accent)] px-1.5 text-[10px] text-[var(--accent-text)]">New</span>
                        )}
                      </span>
                      {m.modelId !== m.displayName && <span className="block truncate text-xs text-[var(--text-faint)]">{m.modelId}</span>}
                    </button>
                  </td>
                  <td className="truncate py-1.5 pr-2 text-xs text-[var(--text-muted)]">{connectionName(m.connectionId)}</td>
                  <td className="py-1.5 pr-2">
                    <Capability name={m.displayName} label="vision" on={m.supportsVision} />
                  </td>
                  <td className="py-1.5 pr-2">
                    <Capability name={m.displayName} label="tools" on={m.supportsTools} />
                  </td>
                  <td className="py-1.5 text-xs tabular-nums text-[var(--text-muted)]">{formatPrice(m)}</td>
                </tr>,
                open && (
                  <tr key={`${m.id}-edit`} className="border-b border-[var(--border)]">
                    <td colSpan={COLUMNS.length}>
                      <ModelEditor key={m.id} model={m} onSaved={upsertModel} />
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
