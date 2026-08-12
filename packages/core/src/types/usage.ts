export interface Usage {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
}

export interface PricingSnapshot {
  priceInPer1m: number | null;
  priceOutPer1m: number | null;
  priceCachedPer1m: number | null;
  currency: string;
}

export function estimateCost(u: Usage, p: PricingSnapshot): number | null {
  if (p.priceInPer1m == null && p.priceOutPer1m == null) return null;
  const uncachedIn = Math.max(0, u.tokensIn - u.tokensCached);
  const inCost = (uncachedIn / 1_000_000) * (p.priceInPer1m ?? 0);
  const cachedCost = (u.tokensCached / 1_000_000) * (p.priceCachedPer1m ?? p.priceInPer1m ?? 0);
  const outCost = ((u.tokensOut + u.tokensReasoning) / 1_000_000) * (p.priceOutPer1m ?? 0);
  return inCost + cachedCost + outCost;
}
