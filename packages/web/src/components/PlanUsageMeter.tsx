import { useEffect, useRef, useState, type JSX } from 'react';
import type { PlanUsage, PlanWindow } from '@otherbench/core/types/usage.js';
import { api } from '../state/api.js';

/** How often an open meter reads the plan usage again (the server serves its last reading until it's this old). */
export const PLAN_USAGE_POLL_MS = 5 * 60_000;

/** The windows the compact line shows, with their short names; the rest are in the tooltip. */
const SHORT: Record<string, string> = { five_hour: '5h', seven_day: 'week' };

/** Amber from 80% used, red from 95%. */
export function usageColour(percent: number): string {
  if (percent >= 95) return 'text-[var(--danger)]';
  if (percent >= 80) return 'text-[var(--warn)]';
  return 'text-[var(--text-muted)]';
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "15:10" for a time today, "Thu 16:00" for another day. */
export function formatReset(at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? clock(at) : `${new Date(at).toLocaleDateString([], { weekday: 'short' })} ${clock(at)}`;
}

/** One line per window, then when it was read: the tooltip, and what a screen reader hears. */
export function usageDetails(usage: PlanUsage, now: number): string {
  const line = (w: PlanWindow) => `${w.label}: ${Math.round(w.percent)}% used${w.resetsAt !== null ? `, resets ${formatReset(w.resetsAt, now)}` : ''}`;
  return [...usage.windows.map(line), `As of ${clock(usage.fetchedAt)}`].join('\n');
}

/**
 * How much of the Claude plan's 5-hour and weekly limits is used (Deck #825),
 * beside Effort in a Claude Code chat: read on mount, every
 * PLAN_USAGE_POLL_MS, and again when a reply finishes (`busy` going false).
 * Shows nothing until there's a reading, or when the login has no plan.
 */
export function PlanUsageMeter({ busy }: { busy: boolean }): JSX.Element | null {
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const wasBusy = useRef(busy);

  async function load(refresh: boolean): Promise<void> {
    try {
      setUsage((await api.claude.planUsage(refresh)).usage);
    } catch (err) {
      // Keep the last reading; the next poll tries again.
      console.error('[otherbench-web] failed to read the Claude plan usage:', err);
    }
  }

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => void load(false), PLAN_USAGE_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (wasBusy.current && !busy) void load(true);
    wasBusy.current = busy;
  }, [busy]);

  if (!usage) return null;
  const compact = usage.windows.filter((w) => SHORT[w.id] !== undefined);
  if (compact.length === 0) return null;
  const details = usageDetails(usage, Date.now());
  return (
    <span
      tabIndex={0}
      data-testid="plan-usage"
      title={details}
      aria-label={`Claude plan usage. ${details.replace(/\n/g, '. ')}`}
      // Hidden in a narrow composer (its @container), so Send keeps its place on the line.
      className="whitespace-nowrap text-xs text-[var(--text-muted)] @max-md:hidden"
    >
      {compact.map((w, i) => (
        <span key={w.id}>
          {i > 0 && ' · '}
          {/* The window names give way in a narrow composer (its @container); the tooltip still lists every window. */}
          <span className="@max-lg:hidden">{SHORT[w.id]} </span>
          <span className={`font-medium ${usageColour(w.percent)}`}>{Math.round(w.percent)}%</span>
        </span>
      ))}
    </span>
  );
}
