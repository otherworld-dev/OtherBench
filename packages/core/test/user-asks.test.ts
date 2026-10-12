import { describe, expect, it, vi } from 'vitest';
import { MAX_PENDING_ASKS, UserAsks } from '../src/domain/user-asks.js';
import type { AskInput, ToolApprovalEvent, ToolContext } from '../src/ports/tool-provider.js';

const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'c1', messageId: 'm1', profileId: 'p1', workspaceRoot: null, signal: new AbortController().signal, ...o });
const QUESTION: AskInput = { kind: 'question', toolName: 'ask_user', questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false }] };
const PLAN: AskInput = { kind: 'plan', toolName: 'propose_plan', plan: '1. Do it' };

function setup() {
  const events: ToolApprovalEvent[] = [];
  const asks = new UserAsks((e) => events.push(e));
  const idOf = (n = 0): string => (events.filter((e) => e.type === 'ask')[n] as Extract<ToolApprovalEvent, { type: 'ask' }>).ask.id;
  return { asks, events, idOf };
}

describe('UserAsks', () => {
  it('raises an ask tied to its reply, waits, and settles with the reply, announcing the end', async () => {
    const { asks, events, idOf } = setup();
    const outcome = asks.ask(ctx(), QUESTION);
    expect(events[0]).toMatchObject({ type: 'ask', ask: { ...QUESTION, chatId: 'c1', messageId: 'm1' } });
    expect(asks.answer(idOf(), { answers: ['Blue'] })).toBe('answered');
    expect(await outcome).toEqual({ reply: { answers: ['Blue'] } });
    expect(events[1]).toEqual({ type: 'ask-resolved', askId: idOf(), messageId: 'm1' });
    expect(asks.pendingCount).toBe(0);
  });

  it('refuses a reply of the wrong kind or an over-long one, and keeps waiting', async () => {
    const { asks, idOf } = setup();
    const outcome = asks.ask(ctx(), PLAN);
    expect(asks.answer(idOf(), { answers: ['x'] })).toEqual({ invalid: expect.stringMatching(/plan/) });
    expect(asks.answer(idOf(), { changes: 'c'.repeat(8001) })).toEqual({ invalid: expect.any(String) });
    expect(asks.answer(idOf(), { approve: true })).toBe('answered');
    expect(await outcome).toEqual({ reply: { approve: true } });
  });

  it('says "unknown" for an id it never had or already settled', async () => {
    const { asks, idOf } = setup();
    expect(asks.answer('nope', { declined: true })).toBe('unknown');
    const outcome = asks.ask(ctx(), QUESTION);
    asks.answer(idOf(), { declined: true });
    await outcome;
    expect(asks.answer(idOf(), { declined: true })).toBe('unknown');
  });

  it('settles as cancelled when the turn stops, and at once without a card when it already has', async () => {
    const { asks, events } = setup();
    const turn = new AbortController();
    const outcome = asks.ask(ctx({ signal: turn.signal }), QUESTION);
    turn.abort();
    expect(await outcome).toEqual({ cancelled: true });
    expect(events.map((e) => e.type)).toEqual(['ask', 'ask-resolved']);
    expect(await asks.ask(ctx({ signal: turn.signal }), QUESTION)).toEqual({ cancelled: true });
    expect(events).toHaveLength(2);
  });

  it('answers an unattended ask at once, raising nothing', async () => {
    const { asks, events } = setup();
    expect(await asks.ask(ctx({ unattended: true }), PLAN)).toEqual({ unattended: true });
    expect(events).toEqual([]);
    expect(asks.pendingCount).toBe(0);
  });

  it(`keeps at most ${MAX_PENDING_ASKS} asks, settling the oldest as cancelled and saying so`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { asks } = setup();
    const first = asks.ask(ctx(), QUESTION);
    for (let i = 1; i < MAX_PENDING_ASKS; i++) void asks.ask(ctx(), QUESTION);
    expect(asks.pendingCount).toBe(MAX_PENDING_ASKS);
    void asks.ask(ctx(), QUESTION);
    expect(await first).toEqual({ cancelled: true });
    expect(asks.pendingCount).toBe(MAX_PENDING_ASKS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
