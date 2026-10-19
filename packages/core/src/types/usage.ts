export interface Usage {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /**
   * Input tokens written to the provider's prompt cache (Anthropic's
   * `cache_creation_input_tokens`), part of `tokensIn` like `tokensCached`.
   * Absent where the engine never reports it.
   */
  tokensCacheWrite?: number;
  tokensReasoning: number;
}

/**
 * What a cache write costs against the input price: Anthropic's 5-minute
 * cache, the only one OtherBench asks for. Providers that cache by themselves
 * report no writes, so this never applies to them.
 */
export const CACHE_WRITE_PRICE_FACTOR = 1.25;

export interface PricingSnapshot {
  priceInPer1m: number | null;
  priceOutPer1m: number | null;
  priceCachedPer1m: number | null;
  currency: string;
}

/**
 * What the server recorded for one finished reply: its tokens, the price list
 * in force when it ran (so editing a model's price never changes what an
 * older reply cost) and the engine call's measured latency (#819).
 */
export interface RecordedUsage extends Usage {
  pricingSnapshot: PricingSnapshot;
  latencyMs: number;
}

/** One of a Claude plan's usage limits (Deck #825): the 5-hour window, the weekly one, or a per-model weekly one. */
export interface PlanWindow {
  /** `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, or `model:<name>` for a per-model weekly window. */
  id: string;
  /** For people: "5-hour", "Weekly", "Fable weekly". */
  label: string;
  /** Share of the window used, 0-100. */
  percent: number;
  /** When the window resets (epoch ms), if known. */
  resetsAt: number | null;
}

/** How much of the Claude subscription's limits is used, as last read (epoch ms). */
export interface PlanUsage {
  windows: PlanWindow[];
  fetchedAt: number;
}

export function estimateCost(u: Usage, p: PricingSnapshot): number | null {
  if (p.priceInPer1m == null && p.priceOutPer1m == null) return null;
  const written = u.tokensCacheWrite ?? 0;
  const uncachedIn = Math.max(0, u.tokensIn - u.tokensCached - written);
  const inCost = (uncachedIn / 1_000_000) * (p.priceInPer1m ?? 0);
  const cachedCost = (u.tokensCached / 1_000_000) * (p.priceCachedPer1m ?? p.priceInPer1m ?? 0);
  const writeCost = (written / 1_000_000) * (p.priceInPer1m ?? 0) * CACHE_WRITE_PRICE_FACTOR;
  const outCost = ((u.tokensOut + u.tokensReasoning) / 1_000_000) * (p.priceOutPer1m ?? 0);
  return inCost + cachedCost + writeCost + outCost;
}
