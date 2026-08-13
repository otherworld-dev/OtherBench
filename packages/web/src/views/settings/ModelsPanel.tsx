import { useState, type JSX } from 'react';
import type { ModelInfo } from '@grunt/core/types/config.js';
import { ApiError, api } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';

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

interface ModelRowProps {
  model: ModelInfo;
  connectionName: string;
  onSaved: (updated: ModelInfo) => void;
}

/**
 * One model's editable row. Discovery (`POST /connections/:id/discover-models`,
 * driven from the Connections panel's "Discover models" button) declares
 * capability flags conservatively (`false`/unknown) for most connection
 * kinds -- Grunt has no reliable handshake for "do you accept images"
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
function ModelRow({ model, connectionName, onSaved }: ModelRowProps): JSX.Element {
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
      console.error(`[grunt-web] failed to save model ${model.id}:`, err);
      setError(errorMessage(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid={`model-row-${model.id}`} className="border-b border-[var(--border)] py-3 last:border-b-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{model.modelId}</div>
          <div className="text-xs text-[var(--text-muted)]">
            {connectionName} · {model.source}
          </div>
        </div>
      </div>

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
          className="rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-text)] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Models panel (task: settings UI, brief item 2). Per connection, lists
 * every discovered (or manually added) model and lets the user edit what
 * Grunt cannot reliably detect on its own: capability flags, context/output
 * limits, and pricing. Reuses the global `models`/`connections` store, so a
 * "Discover models" run from the Connections panel is already reflected
 * here without a refetch.
 */
export function ModelsPanel(): JSX.Element {
  const connections = useGruntStore((s) => s.connections);
  const models = useGruntStore((s) => s.models);
  const upsertModel = useGruntStore((s) => s.upsertModel);

  const [connectionFilter, setConnectionFilter] = useState<string>('all');

  const visible = connectionFilter === 'all' ? models : models.filter((m) => m.connectionId === connectionFilter);
  const connectionName = (id: string): string => connections.find((c) => c.id === id)?.name ?? 'Unknown connection';

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

      <div className="mb-3">
        <label className="text-xs text-[var(--text-muted)]" htmlFor="models-connection-filter">
          Connection
        </label>
        <select
          id="models-connection-filter"
          aria-label="Filter by connection"
          value={connectionFilter}
          onChange={(e) => setConnectionFilter(e.target.value)}
          className="ml-2 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm"
        >
          <option value="all">All connections</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-[var(--text-faint)]">
          No models yet -- discover them from a connection&rsquo;s Test/Discover models buttons in the Connections tab.
        </p>
      ) : (
        <div data-testid="models-list">
          {visible.map((m) => (
            <ModelRow key={m.id} model={m} connectionName={connectionName(m.connectionId)} onSaved={upsertModel} />
          ))}
        </div>
      )}
    </div>
  );
}
