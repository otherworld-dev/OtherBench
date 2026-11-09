import { useEffect, useState, type JSX } from 'react';
import type { UsageRollup } from '@otherbench/core/domain/usage-rollup.js';
import { useChanged } from '../lib/useChanged.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { useSectionSummary } from './InspectorSection.js';
import { EmptyState } from './InspectorParts.js';
import { formatCost } from './inspectorHelpers.js';

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
export function SessionSpend({ chatId }: { chatId: string }): JSX.Element {
  const [rollup, setRollup] = useState<UsageRollup | null>(null);
  const [failed, setFailed] = useState(false);

  const statusSignal = useOtherBenchStore((s) =>
    Object.values(s.messages)
      .filter((m) => m.chatId === chatId && m.role === 'assistant')
      .map((m) => `${m.id}:${m.status}`)
      .sort()
      .join(',')
  );

  // Resets to the "Loading…" state only on a genuine chat switch -- a
  // same-chat re-fetch (triggered by statusSignal below) updates the
  // numbers in place instead of flashing back to a loading state.
  if (useChanged([chatId])) {
    setRollup(null);
    setFailed(false);
    // Deliberately chatId-only, see comment above.
  }

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
        console.error(`[otherbench-web] failed to load usage for chat ${chatId}:`, err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // statusSignal is the deliberate re-fetch trigger described above.
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
