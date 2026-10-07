import { describe, expect, it } from 'vitest';
import { toPlanUsage } from '../src/plan-usage.js';

// Shaped like the live answer recorded on 2026-10-07 (probe-usage.mjs), with its extra fields.
const answer = (rateLimits: unknown, available = true) => ({ subscription_type: 'max', rate_limits_available: available, rate_limits: rateLimits, behaviors: null });

describe('toPlanUsage', () => {
  it('reads the 5-hour, weekly and per-model weekly windows, in that order, ignoring fields it has no use for', () => {
    const usage = toPlanUsage(
      answer({
        five_hour: { utilization: 7, resets_at: '2026-10-07T14:09:59.779957+00:00', limit_dollars: null },
        seven_day: { utilization: 80, resets_at: '2026-10-07T14:59:59.779992+00:00' },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 12.5, resets_at: null },
        seven_day_oauth_apps: { utilization: 3, resets_at: null },
        model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: '2026-10-07T15:00:00+00:00' }],
        extra_usage: { is_enabled: false },
      }),
      1234
    );
    expect(usage).toEqual({
      fetchedAt: 1234,
      windows: [
        { id: 'five_hour', label: '5-hour', percent: 7, resetsAt: Date.parse('2026-10-07T14:09:59.779Z') },
        { id: 'seven_day', label: 'Weekly', percent: 80, resetsAt: Date.parse('2026-10-07T14:59:59.779Z') },
        { id: 'seven_day_sonnet', label: 'Sonnet weekly', percent: 12.5, resetsAt: null },
        { id: 'model:Fable', label: 'Fable weekly', percent: 0, resetsAt: Date.parse('2026-10-07T15:00:00Z') },
      ],
    });
  });

  it('is null when the login has no plan limits, or the answer is missing or unrecognisable', () => {
    for (const a of [null, undefined, 'nope', [], {}, answer(null, false), answer({ five_hour: { utilization: 5 } }, false), answer(null), answer({}), answer({ five_hour: null, model_scoped: 'x' })]) {
      expect(toPlanUsage(a, 1)).toBeNull();
    }
  });

  it('skips a window without a usable percent or name, keeps percents within 0-100, and drops a reset time it cannot read', () => {
    const usage = toPlanUsage(
      answer({
        five_hour: { utilization: null, resets_at: null },
        seven_day: { utilization: 130, resets_at: 'soon' },
        model_scoped: [{ display_name: ' ', utilization: 5 }, { utilization: 5 }, { display_name: 'Opus', utilization: -2, resets_at: null }],
      }),
      1
    );
    expect(usage?.windows).toEqual([
      { id: 'seven_day', label: 'Weekly', percent: 100, resetsAt: null },
      { id: 'model:Opus', label: 'Opus weekly', percent: 0, resetsAt: null },
    ]);
  });
});
