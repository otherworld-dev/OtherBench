import { describe, it, expect } from 'vitest';
import { estimateCost } from '../src/types/usage.js';

describe('estimateCost', () => {
  it('returns null when no pricing is known', () => {
    expect(estimateCost(
      { tokensIn: 100, tokensOut: 50, tokensCached: 0, tokensReasoning: 0 },
      { priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' }
    )).toBeNull();
  });

  it('bills cached tokens at the cached rate and never double-counts them', () => {
    const cost = estimateCost(
      { tokensIn: 1_000_000, tokensOut: 0, tokensCached: 900_000, tokensReasoning: 0 },
      { priceInPer1m: 10, priceOutPer1m: 30, priceCachedPer1m: 1, currency: 'USD' }
    );
    // 100k uncached @ $10/M = $1.00, 900k cached @ $1/M = $0.90
    expect(cost).toBeCloseTo(1.9, 6);
  });

  it('bills reasoning tokens at the output rate', () => {
    const cost = estimateCost(
      { tokensIn: 0, tokensOut: 1_000_000, tokensCached: 0, tokensReasoning: 1_000_000 },
      { priceInPer1m: 10, priceOutPer1m: 30, priceCachedPer1m: null, currency: 'USD' }
    );
    expect(cost).toBeCloseTo(60, 6);
  });

  it('returns zero for a free local model', () => {
    expect(estimateCost(
      { tokensIn: 5000, tokensOut: 5000, tokensCached: 0, tokensReasoning: 0 },
      { priceInPer1m: 0, priceOutPer1m: 0, priceCachedPer1m: 0, currency: 'USD' }
    )).toBe(0);
  });
});
