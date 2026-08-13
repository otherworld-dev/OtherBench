import { useEffect, useState, type JSX } from 'react';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { ModelInfo } from '@grunt/core/types/config.js';
import { api } from '../state/api.js';

function formatCost(cost: number): string {
  return cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

interface PriceDraft {
  priceInPer1m: string;
  priceOutPer1m: string;
  priceCachedPer1m: string;
  currency: string;
}

function draftFor(model: ModelInfo): PriceDraft {
  return {
    priceInPer1m: model.priceInPer1m?.toString() ?? '',
    priceOutPer1m: model.priceOutPer1m?.toString() ?? '',
    priceCachedPer1m: model.priceCachedPer1m?.toString() ?? '',
    currency: model.currency,
  };
}

/** `''` (an intentionally cleared field) becomes `null` ("no price set"); anything else parses as a number, or is rejected. */
function parsePriceField(raw: string): number | null | undefined {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined; // undefined signals "invalid, don't submit"
}

interface PricingRowProps {
  model: ModelInfo;
  onSaved: (updated: ModelInfo) => void;
}

/**
 * One model's editable pricing row. Edits are entirely local (`draft`)
 * until Save is clicked -- `PATCH /api/models/:id` updates the model row
 * only; it never touches any already-written `usage` row, so every past
 * `cost_estimate` stays exactly what it was computed as at the time (each
 * carries its own frozen `pricing_snapshot` for this reason -- see
 * `TurnRunner.writeUsage`, packages/core/src/domain/turn.ts). This is what
 * keeps historical spend numbers truthful across a price change; nothing in
 * this component needs to (or does) reconcile past rows with a new price.
 */
function PricingRow({ model, onSaved }: PricingRowProps): JSX.Element {
  const [draft, setDraft] = useState<PriceDraft>(() => draftFor(model));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(): Promise<void> {
    const priceInPer1m = parsePriceField(draft.priceInPer1m);
    const priceOutPer1m = parsePriceField(draft.priceOutPer1m);
    const priceCachedPer1m = parsePriceField(draft.priceCachedPer1m);
    if (priceInPer1m === undefined || priceOutPer1m === undefined || priceCachedPer1m === undefined) {
      setError('Prices must be numbers (or blank).');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.models.patch(model.id, {
        priceInPer1m,
        priceOutPer1m,
        priceCachedPer1m,
        currency: draft.currency.trim() || 'USD',
      });
      onSaved(updated);
    } catch (err) {
      console.error(`[grunt-web] failed to save pricing for model ${model.id}:`, err);
      setError('Save failed -- please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr data-testid={`pricing-row-${model.id}`} className="border-b border-[var(--border)] last:border-b-0">
      <td className="py-2 pr-3">
        <div className="text-sm font-medium">{model.displayName}</div>
        <div className="text-xs text-[var(--text-muted)]">{model.modelId}</div>
      </td>
      <td className="py-2 pr-2">
        <input
          aria-label={`${model.displayName} price in per 1M tokens`}
          value={draft.priceInPer1m}
          onChange={(e) => setDraft((d) => ({ ...d, priceInPer1m: e.target.value }))}
          className="w-20 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm"
          placeholder="—"
        />
      </td>
      <td className="py-2 pr-2">
        <input
          aria-label={`${model.displayName} price out per 1M tokens`}
          value={draft.priceOutPer1m}
          onChange={(e) => setDraft((d) => ({ ...d, priceOutPer1m: e.target.value }))}
          className="w-20 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm"
          placeholder="—"
        />
      </td>
      <td className="py-2 pr-2">
        <input
          aria-label={`${model.displayName} cached price per 1M tokens`}
          value={draft.priceCachedPer1m}
          onChange={(e) => setDraft((d) => ({ ...d, priceCachedPer1m: e.target.value }))}
          className="w-20 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm"
          placeholder="—"
        />
      </td>
      <td className="py-2 pr-2">
        <input
          aria-label={`${model.displayName} currency`}
          value={draft.currency}
          onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}
          className="w-16 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-1 text-sm"
        />
      </td>
      <td className="py-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="rounded bg-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--accent-text)] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {error && <p className="mt-1 text-xs text-[var(--danger)]">{error}</p>}
      </td>
    </tr>
  );
}

type Tab = 'spend' | 'pricing';

export interface UsageViewProps {
  onClose: () => void;
}

/**
 * Full-screen overlay: task 28's global spend rollup (every chat, sliced by
 * profile/chat/day) and a settings view for editing per-model pricing.
 * Reachable from the header (App.tsx). Both tabs share the same honesty
 * rules `Inspector`'s per-chat section does -- cancelled and unmeasured
 * (errored, no usage row) calls are their own counts, never folded into the
 * total (`buildUsageRollup`, packages/core/src/domain/usage-rollup.ts).
 */
export function UsageView({ onClose }: UsageViewProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('spend');
  const [rollup, setRollup] = useState<UsageRollup | null>(null);
  const [rollupFailed, setRollupFailed] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsFailed, setModelsFailed] = useState(false);

  useEffect(() => {
    api.usage
      .get()
      .then(setRollup)
      .catch((err: unknown) => {
        console.error('[grunt-web] failed to load global usage rollup:', err);
        setRollupFailed(true);
      });
    api.models
      .list()
      .then(setModels)
      .catch((err: unknown) => {
        console.error('[grunt-web] failed to load models for pricing:', err);
        setModelsFailed(true);
      });
  }, []);

  function handleSaved(updated: ModelInfo): void {
    setModels((prev) => (prev ? prev.map((m) => (m.id === updated.id ? updated : m)) : prev));
  }

  return (
    <div data-testid="usage-view" className="fixed inset-0 z-30 flex flex-col bg-[var(--bg)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-semibold">Usage &amp; pricing</h2>
          <div role="tablist" className="flex gap-1">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'spend'}
              onClick={() => setTab('spend')}
              className={`rounded px-2.5 py-1 text-xs font-medium ${tab === 'spend' ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'hover:bg-[var(--bg-sunken)]'}`}
            >
              Spend
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'pricing'}
              onClick={() => setTab('pricing')}
              className={`rounded px-2.5 py-1 text-xs font-medium ${tab === 'pricing' ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'hover:bg-[var(--bg-sunken)]'}`}
            >
              Pricing
            </button>
          </div>
        </div>
        <button type="button" aria-label="Close usage view" onClick={onClose} className="rounded border border-[var(--border)] px-2 py-1 text-xs">
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'spend' &&
          (rollupFailed ? (
            <p className="text-sm text-[var(--danger)]">Couldn&rsquo;t load usage data.</p>
          ) : !rollup ? (
            <p className="text-sm text-[var(--text-faint)]">Loading…</p>
          ) : (
            <div className="mx-auto max-w-3xl space-y-6">
              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">Total</h3>
                <p className="text-2xl font-semibold" data-testid="usage-total">
                  {formatCost(rollup.totalMeasuredCost)}
                </p>
                {(rollup.totalCancelledCount > 0 || rollup.totalUnmeasuredErrorCount > 0) && (
                  <p className="mt-1 text-xs text-[var(--text-faint)]">
                    {rollup.totalCancelledCount > 0 && <>{rollup.totalCancelledCount} cancelled call{rollup.totalCancelledCount === 1 ? '' : 's'} </>}
                    {rollup.totalUnmeasuredErrorCount > 0 && <>{rollup.totalUnmeasuredErrorCount} failed call{rollup.totalUnmeasuredErrorCount === 1 ? '' : 's'} </>}
                    with unmeasured usage -- not included in the total above.
                  </p>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">By profile</h3>
                {rollup.profiles.length === 0 ? (
                  <p className="text-sm text-[var(--text-faint)]">No usage recorded yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {rollup.profiles.map((p) => (
                        <tr key={p.profileId} className="border-b border-[var(--border)] last:border-b-0">
                          <td className="py-1.5">
                            <div className="font-medium">{p.profileName}</div>
                            <div className="text-xs text-[var(--text-muted)]">{p.modelId}</div>
                          </td>
                          <td className="py-1.5 text-right">{formatCost(p.measuredCost)}</td>
                          <td className="py-1.5 pl-3 text-right text-xs text-[var(--text-muted)]">
                            {(p.tokensIn + p.tokensOut + p.tokensReasoning).toLocaleString()} tok
                          </td>
                          {(p.cancelledCount > 0 || p.unmeasuredErrorCount > 0) && (
                            <td className="py-1.5 pl-3 text-right text-xs text-[var(--text-faint)]">
                              {p.cancelledCount > 0 && <>{p.cancelledCount} cancelled </>}
                              {p.unmeasuredErrorCount > 0 && <>{p.unmeasuredErrorCount} unmeasured</>}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">By chat</h3>
                {rollup.chats.length === 0 ? (
                  <p className="text-sm text-[var(--text-faint)]">No usage recorded yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {rollup.chats.map((c) => (
                        <tr key={c.chatId} className="border-b border-[var(--border)] last:border-b-0">
                          <td className="py-1.5">{c.chatTitle}</td>
                          <td className="py-1.5 text-right">{formatCost(c.measuredCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">By day</h3>
                {rollup.buckets.length === 0 ? (
                  <p className="text-sm text-[var(--text-faint)]">No usage recorded yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <tbody>
                      {rollup.buckets.map((b) => (
                        <tr key={b.date} className="border-b border-[var(--border)] last:border-b-0">
                          <td className="py-1.5">{b.date}</td>
                          <td className="py-1.5 text-right">{formatCost(b.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
          ))}

        {tab === 'pricing' &&
          (modelsFailed ? (
            <p className="text-sm text-[var(--danger)]">Couldn&rsquo;t load models.</p>
          ) : !models ? (
            <p className="text-sm text-[var(--text-faint)]">Loading…</p>
          ) : models.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">No models yet -- discover or add one from a connection first.</p>
          ) : (
            <div className="mx-auto max-w-3xl">
              <p className="mb-3 text-xs text-[var(--text-muted)]">
                Prices are per 1M tokens. Editing a price here only affects future calls -- every past usage row keeps the
                pricing snapshot it was actually billed under, so historical spend numbers never change retroactively.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--text-muted)]">
                    <th className="pb-1 font-medium">Model</th>
                    <th className="pb-1 font-medium">In</th>
                    <th className="pb-1 font-medium">Out</th>
                    <th className="pb-1 font-medium">Cached</th>
                    <th className="pb-1 font-medium">Currency</th>
                    <th className="pb-1 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <PricingRow key={m.id} model={m} onSaved={handleSaved} />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>
    </div>
  );
}
