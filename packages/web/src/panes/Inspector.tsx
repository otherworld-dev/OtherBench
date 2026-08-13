import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { UsageRollup } from '@grunt/core/domain/usage-rollup.js';
import type { Chat } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';
import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';

export interface InspectorProps {
  chat: Chat | null;
  profile: Profile | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="border-b border-[var(--border)] px-4 py-3 last:border-b-0">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">{title}</h3>
      {children}
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-[var(--text-faint)]">{children}</p>;
}

function formatCost(cost: number): string {
  return cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/**
 * The "Running session spend" section's body -- fetches task 28's usage
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

  if (failed) return <EmptyState>Couldn&rsquo;t load spend for this chat.</EmptyState>;
  if (!rollup) return <EmptyState>Loading…</EmptyState>;
  if (rollup.profiles.length === 0 && rollup.totalCancelledCount === 0 && rollup.totalUnmeasuredErrorCount === 0) {
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

function fmtParam(label: string, value: number | undefined): JSX.Element | null {
  if (value === undefined) return null;
  return (
    <div key={label} className="flex justify-between text-sm">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * The right pane. Exists specifically to surface the facts that cause harm
 * when hidden -- "this MCP server is down", "this chat can write to disk" --
 * so every section renders even when there is nothing to show yet, with an
 * honest empty state rather than being omitted. Tool grants, MCP health,
 * and spend all land in later tasks; this task wires the pane and its
 * collapse behaviour, not those features.
 */
export function Inspector({ chat, profile, collapsed, onToggleCollapsed }: InspectorProps): JSX.Element {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Expand inspector"
        aria-expanded={false}
        className="flex h-full w-9 flex-col items-center justify-center gap-2 border-l border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-muted)] hover:text-[var(--text)]"
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
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold">Inspector</h2>
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

      <Section title="Profile parameters">
        {!chat ? (
          <EmptyState>No chat selected.</EmptyState>
        ) : !profile ? (
          <EmptyState>This chat's profile could not be loaded.</EmptyState>
        ) : (
          <div className="space-y-2">
            <div className="text-sm font-medium">{profile.name}</div>
            <div className="text-xs text-[var(--text-muted)]">{profile.modelId}</div>
            {profile.description && <p className="text-sm text-[var(--text-muted)]">{profile.description}</p>}
            <div className="space-y-1 pt-1">
              {fmtParam('Temperature', profile.params.temperature)}
              {fmtParam('Top P', profile.params.topP)}
              {fmtParam('Max output tokens', profile.params.maxOutputTokens)}
              {fmtParam('Thinking budget', profile.params.thinkingBudgetTokens)}
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-muted)]">Filesystem</span>
              <span>{profile.toolPolicy.fs}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-muted)]">Shell</span>
              <span>{profile.toolPolicy.shell ? 'on' : 'off'}</span>
            </div>
          </div>
        )}
      </Section>

      <Section title="Tool grants">
        <EmptyState>No grants issued in this chat yet.</EmptyState>
      </Section>

      <Section title="MCP server health">
        <EmptyState>No MCP servers are configured.</EmptyState>
      </Section>

      <Section title="Running session spend">
        {chat ? <SessionSpend chatId={chat.id} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>
    </aside>
  );
}
