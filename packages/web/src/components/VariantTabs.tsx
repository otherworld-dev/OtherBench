import { useEffect, useReducer, useState, type JSX } from 'react';
import type { ModelInfo } from '@grunt/core/types/config.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { PricingSnapshot, Usage } from '@grunt/core/types/usage.js';
import { estimateCost } from '@grunt/core/types/usage.js';
import { Message } from './Message.js';
import type { MessageExtras } from '../state/reducer.js';

/** All-null pricing -- `estimateCost` returns `null` for this, rendered as "—" rather than a misleading $0.00. */
const UNKNOWN_PRICING: PricingSnapshot = { priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' };

/** Finds the `ModelInfo` row (if any) matching a variant's `producedBy`, for its pricing. `profile.modelId`/`producedBy.modelId` is free text -- see profile-resolution.ts -- so a miss (no model ever discovered/added for this connection) is normal, not an error. */
function findPricing(models: ModelInfo[], variant: CanonMessage): PricingSnapshot {
  const producedBy = variant.producedBy;
  if (!producedBy) return UNKNOWN_PRICING;
  const model = models.find((m) => m.connectionId === producedBy.connectionId && m.modelId === producedBy.modelId);
  if (!model) return UNKNOWN_PRICING;
  return { priceInPer1m: model.priceInPer1m, priceOutPer1m: model.priceOutPer1m, priceCachedPer1m: model.priceCachedPer1m, currency: model.currency };
}

function totalTokens(usage: Usage): number {
  return usage.tokensIn + usage.tokensOut + usage.tokensReasoning;
}

function formatCost(cost: number | null): string {
  if (cost === null) return '—';
  if (cost === 0) return '$0.00';
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

function formatTokens(usage: Usage | null): string {
  if (!usage) return '…';
  return `${totalTokens(usage).toLocaleString()} tok`;
}

function formatLatency(ms: number | null): string {
  if (ms === null) return '…';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Frozen (post-completion) latency readings, keyed by message id, living
// outside React state entirely -- so a value survives the tab strip being
// unmounted and remounted (collapsing a turn, then reopening it via its
// chip) within the same page session. This is a client-side, best-effort
// "wall clock since the message row was created" approximation for a
// glanceable tab label, NOT the billing source of truth -- that's the
// server-persisted `usage.latencyMs` (task 28's usage endpoint), computed
// from the engine call's actual start/finish, not the moment this stub was
// registered client-side.
const frozenLatencyCache = new Map<string, number>();

/** Live-while-streaming, frozen-once-terminal elapsed time since `variant.createdAt`. See `frozenLatencyCache`'s doc for what this is (and isn't) a measurement of. */
function useLatencyMs(variant: CanonMessage): number | null {
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (variant.status !== 'streaming') return undefined;
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [variant.status]);

  if (variant.status === 'streaming') {
    return Date.now() - variant.createdAt;
  }
  if (!frozenLatencyCache.has(variant.id)) {
    frozenLatencyCache.set(variant.id, Date.now() - variant.createdAt);
  }
  return frozenLatencyCache.get(variant.id) ?? null;
}

function StatusDot({ status }: { status: CanonMessage['status'] }): JSX.Element {
  const color =
    status === 'streaming'
      ? 'bg-[var(--accent)] animate-pulse'
      : status === 'complete'
        ? 'bg-[var(--success,#3fb950)]'
        : status === 'error'
          ? 'bg-[var(--danger)]'
          : 'bg-[var(--text-faint)]'; // cancelled
  return <span data-testid="status-dot" data-status={status} className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden="true" />;
}

export interface VariantCardProps {
  variant: CanonMessage;
  usage: Usage | null;
  models: ModelInfo[];
  /** Whether this is the currently-kept variant (its tab/card gets a "Kept" marker instead of a "Keep this one" button). */
  isKept: boolean;
  onKeep: () => void;
  onRetry: () => void;
  retrying: boolean;
}

/**
 * One variant's full body: header (status dot, profile/model, cost · latency
 * · tokens), the message content (via `Message` -- the SAME renderer used
 * for an ordinary thread message, per task 27's "container swap, not a
 * second implementation" design), and the Keep/Retry actions. Used both as
 * the single active tab's content (`VariantTabs`) and as one column of the
 * split view (`CompareSplit`) -- identical either way.
 */
export function VariantCard({ variant, usage, models, isKept, onKeep, onRetry, retrying }: VariantCardProps): JSX.Element {
  const latencyMs = useLatencyMs(variant);
  const cost = usage ? estimateCost(usage, findPricing(models, variant)) : null;

  return (
    <div data-testid={`variant-card-${variant.id}`} className="space-y-2 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusDot status={variant.status} />
        <span className="font-medium text-[var(--text)]">{variant.producedBy?.profileName ?? 'Unknown profile'}</span>
        <span className="text-[var(--text-muted)]">{variant.producedBy?.modelId}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[var(--text-muted)]" data-testid={`variant-metrics-${variant.id}`}>
          <span>{formatCost(cost)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatLatency(latencyMs)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatTokens(usage)}</span>
        </span>
      </div>

      <Message message={variant} />

      <div className="flex items-center justify-between gap-2">
        {variant.status === 'error' ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            aria-label={`Retry ${variant.producedBy?.profileName ?? 'variant'}`}
            className="rounded border border-[var(--danger)] px-2 py-1 text-xs font-medium text-[var(--danger)] disabled:opacity-50"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        ) : (
          <span />
        )}
        {isKept ? (
          <span className="text-xs font-medium text-[var(--text-muted)]">✓ Kept</span>
        ) : (
          <button
            type="button"
            onClick={onKeep}
            className="rounded bg-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--accent-text)]"
          >
            Keep this one
          </button>
        )}
      </div>
    </div>
  );
}

interface VariantTabProps {
  variant: CanonMessage;
  usage: Usage | null;
  models: ModelInfo[];
  isKept: boolean;
  isActive: boolean;
  onSelect: () => void;
}

/**
 * One tab button. A standalone component (not an inline `.map()` body) so
 * `useLatencyMs` mounts -- and starts ticking/freezing -- for EVERY variant
 * the moment the strip renders, not only whichever one happens to be the
 * active tab. Without this, a variant's latency would only start being
 * measured the first time a user clicked its tab, which could be long after
 * it actually finished -- exactly the kind of misleading number this
 * component exists to avoid.
 */
function VariantTab({ variant, usage, models, isKept, isActive, onSelect }: VariantTabProps): JSX.Element {
  const latencyMs = useLatencyMs(variant);
  const cost = usage ? estimateCost(usage, findPricing(models, variant)) : null;

  return (
    <button
      type="button"
      role="tab"
      data-testid={`variant-tab-${variant.id}`}
      aria-selected={isActive}
      onClick={onSelect}
      className={`flex flex-col items-start gap-0.5 rounded px-2 py-1 text-left text-xs ${isActive ? 'bg-[var(--bg-sunken)]' : 'hover:bg-[var(--bg-sunken)]'}`}
    >
      <span className="flex items-center gap-1.5 font-medium text-[var(--text)]">
        <StatusDot status={variant.status} />
        {variant.producedBy?.profileName ?? 'Unknown'}
        {isKept && <span aria-label="kept">✓</span>}
      </span>
      <span className="text-[var(--text-muted)]">
        {formatCost(cost)} · {formatLatency(latencyMs)} · {formatTokens(usage)}
      </span>
    </button>
  );
}

export interface VariantTabsProps {
  /** The sibling set -- one turn's variants, creation-ordered (`siblingsOf`/`childrenOf`, packages/core/src/domain/tree.js). */
  variants: CanonMessage[];
  extras: Record<string, MessageExtras>;
  models: ModelInfo[];
  /** The message id currently set as `chat.headMessageId` among these variants, or `null` if this turn hasn't been resolved yet (a fresh compare turn with nothing kept). */
  keptId: string | null;
  onKeep: (messageId: string) => void;
  onRetry: (variant: CanonMessage) => void;
  /** Variant ids with a retry currently in flight, for the per-tab Retry button's disabled/label state. */
  retryingIds: Set<string>;
  /** Present only when this strip was reopened from a "⤺ N other variants" chip -- lets the user collapse back without picking a different variant. Omitted for a fresh, unresolved compare turn (nothing to collapse back to). */
  onClose?: () => void;
}

/**
 * The tab strip: one tab per variant (profile/model, live status dot,
 * cost · latency · tokens on the label itself -- the whole point, per task
 * 27's design, is making the numeric comparison glanceable without
 * switching tabs), plus the `⇹ Split` toggle that swaps the single active
 * tab's content for `CompareSplit`'s two-up grid of the SAME `VariantCard`
 * renderer. Failures are per-tab: one variant erroring never touches its
 * siblings' own tabs, cards, or Retry state.
 */
export function VariantTabs({ variants, extras, models, keptId, onKeep, onRetry, retryingIds, onClose }: VariantTabsProps): JSX.Element {
  const [activeId, setActiveId] = useState<string>(() => keptId ?? variants[0]?.id ?? '');
  const [split, setSplit] = useState(false);
  const active = variants.find((v) => v.id === activeId) ?? variants[0];

  return (
    <div data-testid="variant-tabs" className="rounded border border-[var(--border)] bg-[var(--bg-raised)]">
      <div role="tablist" aria-label="Compare variants" className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] p-1">
        {variants.map((v) => (
          <VariantTab
            key={v.id}
            variant={v}
            usage={extras[v.id]?.usage ?? null}
            models={models}
            isKept={v.id === keptId}
            isActive={v.id === active?.id}
            onSelect={() => setActiveId(v.id)}
          />
        ))}

        <div className="ml-auto flex items-center gap-2 pr-1">
          <button
            type="button"
            aria-pressed={split}
            aria-label="Split view"
            onClick={() => setSplit((s) => !s)}
            className={`rounded border border-[var(--border)] px-2 py-1 text-xs ${split ? 'bg-[var(--bg-sunken)]' : ''}`}
          >
            ⇹ Split
          </button>
          {onClose && (
            <button type="button" aria-label="Collapse variants" onClick={onClose} className="rounded border border-[var(--border)] px-2 py-1 text-xs">
              ✕
            </button>
          )}
        </div>
      </div>

      {split ? (
        <VariantGrid variants={variants} extras={extras} models={models} keptId={keptId} onKeep={onKeep} onRetry={onRetry} retryingIds={retryingIds} />
      ) : (
        active && (
          <div className="p-3">
            <VariantCard
              variant={active}
              usage={extras[active.id]?.usage ?? null}
              models={models}
              isKept={active.id === keptId}
              onKeep={() => onKeep(active.id)}
              onRetry={() => onRetry(active)}
              retrying={retryingIds.has(active.id)}
            />
          </div>
        )
      )}
    </div>
  );
}

/** The grid CompareSplit.tsx renders -- factored out here (rather than duplicated) so VariantTabs's inline split mode and the standalone CompareSplit component are the exact same markup. */
export function VariantGrid({
  variants,
  extras,
  models,
  keptId,
  onKeep,
  onRetry,
  retryingIds,
}: Omit<VariantTabsProps, 'onClose'>): JSX.Element {
  return (
    <div data-testid="compare-split" className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2">
      {variants.map((v) => (
        <VariantCard
          key={v.id}
          variant={v}
          usage={extras[v.id]?.usage ?? null}
          models={models}
          isKept={v.id === keptId}
          onKeep={() => onKeep(v.id)}
          onRetry={() => onRetry(v)}
          retrying={retryingIds.has(v.id)}
        />
      ))}
    </div>
  );
}
