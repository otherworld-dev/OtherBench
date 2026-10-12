/**
 * Live artifacts (spec 2026-10-12-live-artifacts): the in-memory cache, the
 * per-artifact rate limits and the shaping of a tool's result for the page.
 * GruntToolProvider.runLiveCall uses all three, only after the broker has
 * allowed a call. Nothing here touches disk.
 */

export const LIVE_CACHE_TTL_MS = 30_000;
export const LIVE_CACHE_MAX = 100;
export const LIVE_MAX_IN_FLIGHT = 4;
export const LIVE_MAX_PER_MINUTE = 30;
export const LIVE_MAX_RESULT_BYTES = 1024 * 1024;
const MINUTE_MS = 60_000;

/** What a page gets from a call that worked. */
export interface LiveResult {
  text: string;
  json?: unknown;
  structured?: unknown;
  at: number;
}

/** Results by key, for 30 seconds from when each was stored, at most 100 (the oldest go first). Errors are never stored. */
export class LiveCallCache {
  private readonly entries = new Map<string, { value: LiveResult; storedAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = LIVE_CACHE_TTL_MS,
    private readonly max = LIVE_CACHE_MAX
  ) {}

  get(key: string): LiveResult | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (this.now() - hit.storedAt >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: LiveResult): void {
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: this.now() });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** Per key (an artifact): at most 4 calls in flight and 30 started in any rolling minute. */
export class LiveCallLimiter {
  private readonly inFlight = new Map<string, number>();
  private readonly starts = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxInFlight = LIVE_MAX_IN_FLIGHT,
    private readonly perMinute = LIVE_MAX_PER_MINUTE
  ) {}

  /** True, and counted, when a call may start now; false when it would break a limit. */
  tryStart(key: string): boolean {
    const t = this.now();
    const recent = (this.starts.get(key) ?? []).filter((s) => t - s < MINUTE_MS);
    const running = this.inFlight.get(key) ?? 0;
    if (running >= this.maxInFlight || recent.length >= this.perMinute) {
      this.starts.set(key, recent);
      return false;
    }
    recent.push(t);
    this.starts.set(key, recent);
    this.inFlight.set(key, running + 1);
    return true;
  }

  /** A started call ended, however it ended. */
  finish(key: string): void {
    const running = (this.inFlight.get(key) ?? 1) - 1;
    if (running <= 0) this.inFlight.delete(key);
    else this.inFlight.set(key, running);
  }
}

/**
 * Per key (an artifact): which `rate_limited` refusals get an audit row. The
 * first in a minute does and the rest are only counted, so a page that keeps
 * asking can't grow the audit table without bound; the count goes on the
 * key's next audited row, whatever that row is.
 */
export class LiveRefusalAudit {
  private readonly windows = new Map<string, { since: number; unaudited: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A rate_limited refusal: null when it's only counted, else the unaudited count its row should carry. */
  rateLimited(key: string): number | null {
    const t = this.now();
    const window = this.windows.get(key);
    if (window && t - window.since < MINUTE_MS) {
      window.unaudited += 1;
      return null;
    }
    this.windows.set(key, { since: t, unaudited: 0 });
    return window?.unaudited ?? 0;
  }

  /** Any other audited live call: the unaudited count its row should carry, which it takes. */
  take(key: string): number {
    const window = this.windows.get(key);
    if (!window) return 0;
    const unaudited = window.unaudited;
    if (this.now() - window.since >= MINUTE_MS) this.windows.delete(key);
    else window.unaudited = 0;
    return unaudited;
  }
}

/**
 * A tool's MCP result as the page gets it: its text blocks joined with
 * newlines, `json` when the whole text parses as JSON, and `structured` when
 * the server sent `structuredContent`. Images and resources are dropped.
 * Over 1 MB of text and structured JSON together is refused.
 */
export function shapeLiveResult(content: unknown, structured: unknown): { ok: true; text: string; json?: unknown; structured?: unknown } | { ok: false; code: 'too_large'; message: string } {
  const texts = Array.isArray(content)
    ? content
        .filter((c): c is { type: 'text'; text: string } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string')
        .map((c) => c.text)
    : [];
  const text = texts.join('\n');
  const structuredJson = structured === undefined ? '' : (JSON.stringify(structured) ?? '');
  if (Buffer.byteLength(text, 'utf8') + Buffer.byteLength(structuredJson, 'utf8') > LIVE_MAX_RESULT_BYTES) {
    return { ok: false, code: 'too_large', message: "The tool's result is over 1 MB, so the page can't have it." };
  }
  let json: unknown;
  let hasJson = false;
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text);
      hasJson = true;
    } catch {
      // Not JSON: the page still gets the text.
    }
  }
  return { ok: true, text, ...(hasJson ? { json } : {}), ...(structured !== undefined ? { structured } : {}) };
}
