import { describe, it, expect } from 'vitest';
import type { UsageRecord } from '../src/ports/store.js';
import type { CanonMessage } from '../src/types/messages.js';
import type { PricingSnapshot } from '../src/types/usage.js';
import { buildUsageRollup } from '../src/domain/usage-rollup.js';

const pricing: PricingSnapshot = { priceInPer1m: 3, priceOutPer1m: 15, priceCachedPer1m: null, currency: 'USD' };

function usage(over: Partial<UsageRecord> & { id: string; messageId: string }): UsageRecord {
  return {
    chatId: 'chat-1',
    profileId: 'profile-a',
    connectionId: 'conn-1',
    modelId: 'model-x',
    tokensIn: 1_000_000,
    tokensOut: 0,
    tokensCached: 0,
    tokensReasoning: 0,
    costEstimate: 3, // 1M tokensIn @ $3/1M
    pricingSnapshot: pricing,
    latencyMs: 500,
    ...over,
  };
}

function assistantMessage(over: Partial<CanonMessage> & { id: string }): CanonMessage {
  return {
    chatId: 'chat-1',
    parentId: 'user-1',
    role: 'assistant',
    parts: [],
    status: 'complete',
    error: null,
    producedBy: { profileId: 'profile-a', profileName: 'Profile A', connectionId: 'conn-1', modelId: 'model-x' },
    createdAt: Date.parse('2026-08-10T12:00:00Z'),
    ...over,
  };
}

describe('buildUsageRollup', () => {
  const subPart = (callId: string, profileName: string, modelId: string) => ({
    type: 'subagent' as const, callId, label: 'Helper', prompt: 'p', profileId: 'profile-b', profileName, modelId, status: 'complete' as const, parts: [],
  });

  it("counts a sub-agent's row as measured spend under its own profile, with subagentCount", () => {
    const rollup = buildUsageRollup(
      [
        usage({ id: 'own', messageId: 'm1' }),
        usage({ id: 'sub', messageId: 'm1', profileId: 'profile-b', modelId: 'model-b', subagentCallId: 'call-1', costEstimate: 1, tokensIn: 10 }),
      ],
      [assistantMessage({ id: 'm1', parts: [subPart('call-1', 'Cheap', 'model-b')] })]
    );
    const a = rollup.profiles.find((p) => p.profileId === 'profile-a')!;
    const b = rollup.profiles.find((p) => p.profileId === 'profile-b')!;
    expect(a).toMatchObject({ completeCount: 1, subagentCount: 0, measuredCost: 3 });
    expect(b).toMatchObject({ profileName: 'Cheap', modelId: 'model-b', completeCount: 0, subagentCount: 1, measuredCost: 1, tokensIn: 10 });
    expect(rollup.totalMeasuredCost).toBe(4);
    expect(rollup.buckets).toEqual([{ date: '2026-08-10', cost: 4 }]);
  });

  it('counts a sub-agent that finished under a cancelled reply as measured, not cancelled', () => {
    const rollup = buildUsageRollup(
      [usage({ id: 'own', messageId: 'm1', costEstimate: 0, tokensIn: 0 }), usage({ id: 'sub', messageId: 'm1', subagentCallId: 'call-1', costEstimate: 2 })],
      [assistantMessage({ id: 'm1', status: 'cancelled', parts: [subPart('call-1', 'Profile A', 'model-x')] })]
    );
    expect(rollup.profiles[0]).toMatchObject({ cancelledCount: 1, subagentCount: 1, measuredCost: 2 });
    expect(rollup.totalCancelledCount).toBe(1);
  });

  it("doesn't let a sub-agent's row hide a failed reply that has no row of its own", () => {
    const rollup = buildUsageRollup(
      [usage({ id: 'sub', messageId: 'm1', subagentCallId: 'call-1', costEstimate: 2 })],
      [assistantMessage({ id: 'm1', status: 'error', parts: [] })]
    );
    expect(rollup.totalUnmeasuredErrorCount).toBe(1);
    // Its card is gone (a retry clears the parts): the row still counts, under its own profile id,
    // named after the reply's profile when it ran as that one.
    expect(rollup.profiles.find((p) => p.subagentCount === 1)).toMatchObject({ profileId: 'profile-a', profileName: 'Profile A', modelId: 'model-x', measuredCost: 2 });
    const other = buildUsageRollup(
      [usage({ id: 'sub', messageId: 'm1', profileId: 'profile-z', subagentCallId: 'call-1', costEstimate: 2 })],
      [assistantMessage({ id: 'm1', parts: [] })]
    );
    expect(other.profiles.find((p) => p.profileId === 'profile-z')).toMatchObject({ profileName: 'Unknown profile', subagentCount: 1 });
  });

  it('sums cost and tokens for a single profile across two complete variants', () => {
    const rows = [
      usage({ id: 'u1', messageId: 'm1', costEstimate: 3, tokensIn: 1_000_000 }),
      usage({ id: 'u2', messageId: 'm2', costEstimate: 1.5, tokensIn: 500_000 }),
    ];
    const messages = [assistantMessage({ id: 'm1' }), assistantMessage({ id: 'm2' })];

    const rollup = buildUsageRollup(rows, messages);

    expect(rollup.profiles).toHaveLength(1);
    expect(rollup.profiles[0]).toMatchObject({
      profileId: 'profile-a',
      profileName: 'Profile A',
      measuredCost: 4.5,
      tokensIn: 1_500_000,
      completeCount: 2,
      cancelledCount: 0,
      unmeasuredErrorCount: 0,
    });
    expect(rollup.totalMeasuredCost).toBe(4.5);
  });

  it('keeps different profiles in separate rollup entries', () => {
    const rows = [
      usage({ id: 'u1', messageId: 'm1', profileId: 'profile-a', costEstimate: 2 }),
      usage({ id: 'u2', messageId: 'm2', profileId: 'profile-b', costEstimate: 5 }),
    ];
    const messages = [
      assistantMessage({ id: 'm1', producedBy: { profileId: 'profile-a', profileName: 'Alpha', connectionId: 'conn-1', modelId: 'model-x' } }),
      assistantMessage({ id: 'm2', producedBy: { profileId: 'profile-b', profileName: 'Beta', connectionId: 'conn-1', modelId: 'model-y' } }),
    ];

    const rollup = buildUsageRollup(rows, messages);

    expect(rollup.profiles.map((p) => p.profileId).sort()).toEqual(['profile-a', 'profile-b']);
    expect(rollup.totalMeasuredCost).toBe(7);
  });

  // Honesty issue #1 (task 28 brief): a cancelled variant writes an
  // all-zero usage row -- estimateCost returns 0 for it, not null, so a
  // naive SUM(cost_estimate) would silently fold "cancelled, unmeasured"
  // in with "genuinely free". The rollup must keep it out of the reported
  // spend and surface it as its own count instead.
  it('excludes a cancelled variant\'s zero usage from measuredCost/buckets and reports it as cancelledCount instead', () => {
    const rows = [
      usage({ id: 'u1', messageId: 'm1', costEstimate: 3 }), // genuinely measured
      usage({ id: 'u2', messageId: 'm2', costEstimate: 0, tokensIn: 0, tokensOut: 0 }), // cancelled mid-stream
    ];
    const messages = [assistantMessage({ id: 'm1', status: 'complete' }), assistantMessage({ id: 'm2', status: 'cancelled' })];

    const rollup = buildUsageRollup(rows, messages);

    expect(rollup.profiles[0]).toMatchObject({ measuredCost: 3, completeCount: 1, cancelledCount: 1 });
    expect(rollup.totalMeasuredCost).toBe(3);
    expect(rollup.totalCancelledCount).toBe(1);
    // The cancelled row's zero cost never reaches a date bucket either.
    expect(rollup.buckets).toHaveLength(1);
  });

  // Honesty issue #2 (task 28 brief): an errored variant that never
  // received a `finish` event writes NO usage row at all, so it's invisible
  // to usage.list(). The rollup must still surface it (from the assistant
  // message set, not the usage rows) rather than let it silently vanish.
  it('surfaces an errored variant with no usage row at all as unmeasuredErrorCount, not silently', () => {
    const rows = [usage({ id: 'u1', messageId: 'm1', costEstimate: 3 })];
    const messages = [
      assistantMessage({ id: 'm1', status: 'complete' }),
      assistantMessage({ id: 'm2', status: 'error', error: { kind: 'rate_limit', message: 'boom', retryable: true } }),
    ];

    const rollup = buildUsageRollup(rows, messages);

    expect(rollup.profiles[0]).toMatchObject({ measuredCost: 3, unmeasuredErrorCount: 1 });
    expect(rollup.totalUnmeasuredErrorCount).toBe(1);
    // Still visible in the totals -- not folded into the cost total, and not dropped.
    expect(rollup.totalMeasuredCost).toBe(3);
  });

  it('an errored message that DID race a finish event (has a usage row) counts as measured, not unmeasured', () => {
    const rows = [usage({ id: 'u1', messageId: 'm1', costEstimate: 2 })];
    const messages = [assistantMessage({ id: 'm1', status: 'error', error: { kind: 'transient', message: 'late failure', retryable: true } })];

    const rollup = buildUsageRollup(rows, messages);

    expect(rollup.profiles[0]).toMatchObject({ measuredCost: 2, completeCount: 1, unmeasuredErrorCount: 0 });
    expect(rollup.totalUnmeasuredErrorCount).toBe(0);
  });

  it('a still-streaming variant with no usage row yet is not counted anywhere', () => {
    const messages = [assistantMessage({ id: 'm1', status: 'streaming' })];
    const rollup = buildUsageRollup([], messages);

    expect(rollup.profiles).toHaveLength(0);
    expect(rollup.totalMeasuredCost).toBe(0);
    expect(rollup.totalUnmeasuredErrorCount).toBe(0);
  });

  it('buckets measured cost by the message\'s creation date (UTC, YYYY-MM-DD), summing same-day entries', () => {
    const rows = [
      usage({ id: 'u1', messageId: 'm1', costEstimate: 1 }),
      usage({ id: 'u2', messageId: 'm2', costEstimate: 2 }),
      usage({ id: 'u3', messageId: 'm3', costEstimate: 5 }),
    ];
    const messages = [
      assistantMessage({ id: 'm1', createdAt: Date.parse('2026-08-10T09:00:00Z') }),
      assistantMessage({ id: 'm2', createdAt: Date.parse('2026-08-10T20:00:00Z') }),
      assistantMessage({ id: 'm3', createdAt: Date.parse('2026-08-11T09:00:00Z') }),
    ];

    const rollup = buildUsageRollup(rows, messages);

    expect(rollup.buckets).toEqual([
      { date: '2026-08-10', cost: 3 },
      { date: '2026-08-11', cost: 5 },
    ]);
  });

  it('breaks spend down per chat as well as per profile, resolving chat titles when given', () => {
    const rows = [
      usage({ id: 'u1', messageId: 'm1', chatId: 'chat-a', costEstimate: 4 }),
      usage({ id: 'u2', messageId: 'm2', chatId: 'chat-b', costEstimate: 10 }),
    ];
    const messages = [assistantMessage({ id: 'm1', chatId: 'chat-a' }), assistantMessage({ id: 'm2', chatId: 'chat-b' })];

    const rollup = buildUsageRollup(rows, messages, { 'chat-a': 'Ocean facts', 'chat-b': 'Untitled chat' });

    expect(rollup.chats.find((c) => c.chatId === 'chat-a')).toMatchObject({ chatTitle: 'Ocean facts', measuredCost: 4 });
    expect(rollup.chats.find((c) => c.chatId === 'chat-b')).toMatchObject({ chatTitle: 'Untitled chat', measuredCost: 10 });
  });

  it('falls back to the raw chat id as the title when no chatTitles entry is given', () => {
    const rows = [usage({ id: 'u1', messageId: 'm1', chatId: 'chat-z', costEstimate: 1 })];
    const messages = [assistantMessage({ id: 'm1', chatId: 'chat-z' })];

    const rollup = buildUsageRollup(rows, messages);

    expect(rollup.chats[0]).toMatchObject({ chatId: 'chat-z', chatTitle: 'chat-z' });
  });

  it('ignores a usage row whose message is not in the given assistant-message set (out-of-scope defensiveness)', () => {
    const rows = [usage({ id: 'u1', messageId: 'not-in-scope', costEstimate: 99 })];
    const rollup = buildUsageRollup(rows, []);

    expect(rollup.profiles).toHaveLength(0);
    expect(rollup.totalMeasuredCost).toBe(0);
  });

  it('treats a null costEstimate (no pricing configured) as zero for totals without throwing', () => {
    const rows = [usage({ id: 'u1', messageId: 'm1', costEstimate: null })];
    const messages = [assistantMessage({ id: 'm1' })];

    const rollup = buildUsageRollup(rows, messages);

    expect(rollup.profiles[0]?.measuredCost).toBe(0);
    expect(rollup.totalMeasuredCost).toBe(0);
  });
});
