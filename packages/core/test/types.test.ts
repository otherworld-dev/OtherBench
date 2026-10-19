import { describe, it, expect } from 'vitest';
import { estimateCost } from '../src/types/usage.js';
import type { EngineEvent, EngineRequest } from '../src/ports/chat-engine.js';
import type { ConnectionKind, ToolPolicy, ToolSource } from '../src/types/config.js';
import type { CanonMessage, EngineMeta } from '../src/types/messages.js';

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

  it('bills cache writes at 1.25x the input rate, out of the input tokens', () => {
    const cost = estimateCost(
      { tokensIn: 1_000_000, tokensOut: 0, tokensCached: 500_000, tokensCacheWrite: 400_000, tokensReasoning: 0 },
      { priceInPer1m: 10, priceOutPer1m: 30, priceCachedPer1m: 1, currency: 'USD' }
    );
    // 100k uncached @ $10/M = $1.00, 500k read @ $1/M = $0.50, 400k written @ $12.50/M = $5.00
    expect(cost).toBeCloseTo(6.5, 6);
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

describe('claude code engine types', () => {
  it('accepts the new kinds, sources, policy flags, meta and events', () => {
    const kind: ConnectionKind = 'claude_code';
    const source: ToolSource = 'agent';
    const policy: ToolPolicy = { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate', agentWeb: false, agentMcp: true };
    const meta: EngineMeta = { engine: 'claude_code', sessionId: 's1', backend: 'claude', cwd: '/ws', tools: ['Read'], mcpServers: [{ name: 'x', status: 'connected' }] };
    const msg: Pick<CanonMessage, 'engineMeta'> = { engineMeta: meta };
    const events: EngineEvent[] = [{ type: 'engine-meta', meta }, { type: 'notice', text: 'hi' }];
    const req: Pick<EngineRequest, 'purpose' | 'latestMessageForSession'> = { purpose: 'utility', latestMessageForSession: () => null };
    expect([kind, source, policy.agentWeb, msg.engineMeta?.sessionId, events.length, req.purpose]).toEqual(['claude_code', 'agent', false, 's1', 2, 'utility']);
  });
});
