import type { PlanUsage, PlanWindow } from '@grunt/core/types/usage.js';

/** The plan-wide windows Grunt shows, in order, with their labels. `seven_day_oauth_apps` is left out: it counts other apps, not Claude Code. */
const WINDOWS: readonly (readonly [string, string])[] = [
  ['five_hour', '5-hour'],
  ['seven_day', 'Weekly'],
  ['seven_day_opus', 'Opus weekly'],
  ['seven_day_sonnet', 'Sonnet weekly'],
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function window(id: string, label: string, raw: unknown): PlanWindow | null {
  const w = record(raw);
  const percent = w?.['utilization'];
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  const resets = typeof w?.['resets_at'] === 'string' ? Date.parse(w['resets_at']) : NaN;
  return { id, label, percent: Math.min(100, Math.max(0, percent)), resetsAt: Number.isNaN(resets) ? null : resets };
}

/**
 * Grunt's reading of the SDK's experimental usage answer (the data behind
 * Claude Code's /usage), or null when the login has no plan limits or the
 * answer has no window Grunt understands. The SDK may change this shape
 * without notice, so every field is checked here rather than trusted.
 */
export function toPlanUsage(answer: unknown, fetchedAt: number): PlanUsage | null {
  const a = record(answer);
  if (!a || a['rate_limits_available'] !== true) return null;
  const limits = record(a['rate_limits']);
  if (!limits) return null;
  const windows: PlanWindow[] = [];
  for (const [id, label] of WINDOWS) {
    const w = window(id, label, limits[id]);
    if (w) windows.push(w);
  }
  if (Array.isArray(limits['model_scoped'])) {
    for (const raw of limits['model_scoped']) {
      const name = record(raw)?.['display_name'];
      if (typeof name !== 'string' || name.trim() === '') continue;
      const w = window(`model:${name}`, `${name} weekly`, raw);
      if (w) windows.push(w);
    }
  }
  return windows.length > 0 ? { windows, fetchedAt } : null;
}
