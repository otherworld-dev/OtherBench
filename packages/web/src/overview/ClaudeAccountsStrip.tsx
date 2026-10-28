import { useEffect, useRef, useState, type JSX } from 'react';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import { formatReset, PLAN_USAGE_POLL_MS, usageColour } from '../components/PlanUsageMeter.js';
import { api } from '../state/api.js';
import { useClaudeAccounts } from '../state/claudeAccounts.js';

/** A reading per account slug: a usage, null (no plan / nothing yet) or 'failed'. */
type Readings = Record<string, PlanUsage | null | 'failed'>;

const WINDOWS = [
  { id: 'five_hour', short: '5h' },
  { id: 'seven_day', short: 'week' },
] as const;

/**
 * Every Claude account's plan usage on the Overview: a dot, the name, the 5-hour and weekly
 * figures, and "Limited until" while the account is rate limited. Reads each account in
 * parallel every PLAN_USAGE_POLL_MS and again when `refreshKey` changes (the Overview's refresh),
 * then reloads the accounts, whose "Limited until" a reading may have changed.
 */
export function ClaudeAccountsStrip({ refreshKey }: { refreshKey: number }): JSX.Element | null {
  const accounts = useClaudeAccounts((s) => s.accounts);
  const [readings, setReadings] = useState<Readings>({});
  const slugs = accounts.map((a) => a.slug).join('\n');
  const first = useRef(true);

  useEffect(() => {
    if (useClaudeAccounts.getState().accounts.length === 0) {
      useClaudeAccounts.getState().load().catch((err: unknown) => console.error('[otherbench-web] failed to load the Claude accounts:', err));
    }
  }, []);

  useEffect(() => {
    if (slugs === '') return;
    let live = true;
    const force = !first.current;
    first.current = false;
    const read = async (refresh: boolean): Promise<void> => {
      const entries = await Promise.all(
        slugs.split('\n').map(async (slug): Promise<[string, PlanUsage | null | 'failed']> => {
          try {
            return [slug, (await api.claude.planUsage(refresh, slug)).usage];
          } catch (err) {
            console.error('[otherbench-web] failed to read the Claude plan usage:', err);
            return [slug, 'failed'];
          }
        }),
      );
      if (!live) return;
      // A failed poll keeps the last good reading; only an account that never had one shows "—".
      setReadings((prev) => Object.fromEntries(entries.map(([slug, r]) => [slug, r === 'failed' && prev[slug] && prev[slug] !== 'failed' ? prev[slug] : r])));
      // A reading can set or let go of an account's hold on the server: reload the accounts for their "Limited until".
      useClaudeAccounts.getState().load().catch((err: unknown) => console.error('[otherbench-web] failed to load the Claude accounts:', err));
    };
    void read(force);
    const timer = setInterval(() => void read(false), PLAN_USAGE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [slugs, refreshKey]);

  const hasReading = Object.values(readings).some((r) => r !== null && r !== 'failed');
  if (accounts.length === 0 || (accounts.length === 1 && accounts[0]?.main && !hasReading)) return null;

  const now = Date.now();
  return (
    <div data-testid="claude-accounts-strip" className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-muted)]">
      {accounts.map((a) => {
        const reading = readings[a.slug];
        const limitedUntil = a.limitedUntil !== null && a.limitedUntil > now ? a.limitedUntil : null;
        const dot = a.main ? 'var(--text-muted)' : (a.colour ?? 'var(--accent)');
        return (
          <span key={a.slug} data-testid={`claude-account-${a.slug}`} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
            <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
            <span className="text-[var(--text)]">{a.name}</span>
            {WINDOWS.map((w) => {
              const win = reading && reading !== 'failed' ? reading.windows.find((x) => x.id === w.id) : undefined;
              return win ? (
                <span key={w.id} className={usageColour(win.percent)}>{`${w.short} ${Math.round(win.percent)}%`}</span>
              ) : (
                <span key={w.id}>{w.short} —</span>
              );
            })}
            {limitedUntil !== null && <span className="text-[var(--danger)]">{`Limited until ${formatReset(limitedUntil, now)}`}</span>}
          </span>
        );
      })}
    </div>
  );
}
