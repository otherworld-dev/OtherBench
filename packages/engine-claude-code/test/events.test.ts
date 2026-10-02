import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SdkEventMapper, type MappedEvent } from '../src/events.js';

const fixture = (name: string): SDKMessage[] => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', `${name}.json`), 'utf8'));
const run = (msgs: SDKMessage[]): MappedEvent[] => { const m = new SdkEventMapper(); return msgs.flatMap((x) => m.map(x)); };
const textOf = (events: MappedEvent[]): string => events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');

describe('SdkEventMapper on recorded turns', () => {
  it('text turn: init, streamed text, finish', () => {
    const events = run(fixture('text-turn'));
    expect(events[0]).toMatchObject({ type: 'init', sessionId: expect.any(String) });
    expect(textOf(events)).toMatch(/pong/i);
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'end_turn' });
  });
  it('tool turn: tool-call/tool-result pairs with names, then finish', () => {
    const msgs = fixture('tool-turn');
    const events = run(msgs);
    const calls = events.filter((e) => e.type === 'tool-call') as Extract<MappedEvent, { type: 'tool-call' }>[];
    const results = events.filter((e) => e.type === 'tool-result') as Extract<MappedEvent, { type: 'tool-result' }>[];
    expect(calls.map((c) => c.name)).toEqual(['Read', 'Bash', 'Edit']);
    expect(results).toHaveLength(3);
    for (const r of results) expect(calls.find((c) => c.id === r.id)?.name).toBe(r.name);
    expect(results[1]).toMatchObject({ name: 'Bash', result: 'grunt-probe', isError: false });
    expect(calls[0]?.args).toMatchObject({ file_path: expect.stringContaining('hello.txt') });
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'end_turn' });
    // Text arrives via stream deltas; assistant text blocks must not repeat it.
    const final = (msgs.at(-1) as unknown as { result: string }).result;
    const text = textOf(events);
    expect(text.endsWith(final)).toBe(true);
    expect(text.split(final)).toHaveLength(2);
    expect(text.split("Now I'll append")).toHaveLength(2);
  });
  it('denied tool turn maps the call and finishes without an error event', () => {
    const events = run(fixture('denied-tool-turn'));
    expect(events.some((e) => e.type === 'tool-call' && e.name === 'Bash')).toBe(true);
    expect(events.some((e) => e.type === 'result-error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
  });
});

describe('SdkEventMapper on synthetic messages', () => {
  const ev = (event: object, parent: string | null = null) => ({ type: 'stream_event', event, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
  it('maps text and thinking deltas, ignoring subagent streams', () => {
    const m = new SdkEventMapper();
    expect(m.map(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }))).toEqual([{ type: 'text-delta', text: 'a' }]);
    expect(m.map(ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'b' } }))).toEqual([{ type: 'reasoning-delta', text: 'b' }]);
    expect(m.map(ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub' } }, 'toolu_1'))).toEqual([]);
  });
  it('ignores a stream_event with no event payload instead of throwing', () => {
    const m = new SdkEventMapper();
    expect(m.map({ type: 'stream_event', parent_tool_use_id: null, uuid: 'u', session_id: 's' } as unknown as SDKMessage)).toEqual([]);
    expect(m.map({ type: 'stream_event', event: null, parent_tool_use_id: null, uuid: 'u', session_id: 's' } as unknown as SDKMessage)).toEqual([]);
  });
  it('falls back to assistant text blocks when no deltas streamed', () => {
    const m = new SdkEventMapper();
    const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'whole' }] }, parent_tool_use_id: null, uuid: 'u', session_id: 's' } as unknown as SDKMessage;
    expect(m.map(assistant)).toEqual([{ type: 'text-delta', text: 'whole' }]);
  });
  it('maps an error result and a rejected rate limit', () => {
    const m = new SdkEventMapper();
    expect(m.map({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1700000000 }, uuid: 'u', session_id: 's' } as unknown as SDKMessage)).toEqual([{ type: 'rate-limited', resetsAt: 1700000000 }]);
    expect(m.map({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: { input_tokens: 0, output_tokens: 0 } } as unknown as SDKMessage)).toEqual([{ type: 'result-error', text: 'boom' }]);
  });
  it('maps success usage, counting cache reads and writes as input', () => {
    const m = new SdkEventMapper();
    const out = m.map({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'ok', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } as unknown as SDKMessage);
    expect(out).toEqual([{ type: 'finish', finishReason: 'end_turn', usage: { tokensIn: 130, tokensOut: 5, tokensCached: 100, tokensReasoning: 0 } }]);
  });
});
