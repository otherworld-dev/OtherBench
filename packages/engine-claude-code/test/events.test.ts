import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SdkEventMapper, type MappedEvent } from '../src/events.js';
import { HelperRegistry } from '../src/helpers.js';

const fixture = (name: string): SDKMessage[] => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', `${name}.json`), 'utf8'));
const run = (msgs: SDKMessage[]): MappedEvent[] => { const m = new SdkEventMapper(); return msgs.flatMap((x) => m.map(x)); };
const textOf = (events: MappedEvent[]): string => events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text).join('');

describe('SdkEventMapper on recorded turns', () => {
  it('carries the session permission mode on init', () => {
    expect(run(fixture('text-turn'))[0]).toMatchObject({ type: 'init', permissionMode: 'default' });
    const bare = new SdkEventMapper().map({ type: 'system', subtype: 'init', session_id: 's', tools: [], mcp_servers: [] } as unknown as SDKMessage);
    expect(bare[0]).toMatchObject({ type: 'init', permissionMode: null });
  });
  it('text turn: init, streamed text, finish', () => {
    const events = run(fixture('text-turn'));
    expect(events[0]).toMatchObject({ type: 'init', sessionId: expect.any(String) });
    expect(textOf(events)).toMatch(/pong/i);
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'end_turn' });
  });
  it('tool turn: tool-call/tool-result pairs with names, then finish', () => {
    const msgs = fixture('tool-turn');
    const events = run(msgs);
    const calls = events.filter((e) => e.type === 'tool-call');
    const results = events.filter((e) => e.type === 'tool-result');
    expect(calls.map((c) => c.name)).toEqual(['Read', 'Bash', 'Edit']);
    expect(results).toHaveLength(3);
    for (const r of results) expect(calls.find((c) => c.id === r.id)?.name).toBe(r.name);
    expect(results[1]).toMatchObject({ name: 'Bash', result: 'otherbench-probe', isError: false });
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
  it('says when the main agent starts and stops thinking, even with no thinking text', () => {
    const m = new SdkEventMapper({ now: () => 5000 });
    expect(m.map(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }))).toEqual([{ type: 'thinking', since: 5000 }]);
    expect(m.map(ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } }))).toEqual([]);
    expect(m.map(ev({ type: 'content_block_stop', index: 0 }))).toEqual([{ type: 'thinking', since: null }]);
    // A text block's stop says nothing more.
    expect(m.map(ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))).toEqual([]);
    expect(m.map(ev({ type: 'content_block_stop', index: 1 }))).toEqual([]);
    // A helper's thinking is its own.
    expect(m.map(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }, 'toolu_1'))).toEqual([]);
  });
  it("carries Claude Code's thinking-token estimate only while the reply's own thinking block is open", () => {
    const m = new SdkEventMapper({ now: () => 5000 });
    const tokens = (n: number) => ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: n, estimated_tokens_delta: 50, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
    expect(m.map(tokens(50))).toEqual([]);
    m.map(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
    expect(m.map(tokens(1200))).toEqual([{ type: 'thinking', since: 5000, tokens: 1200 }]);
    m.map(ev({ type: 'content_block_stop', index: 0 }));
    expect(m.map(tokens(1300))).toEqual([]);
  });
  it('ends thinking left open when the message or the turn ends', () => {
    const m = new SdkEventMapper({ now: () => 7 });
    m.map(ev({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } }));
    expect(m.map(ev({ type: 'message_stop' }))).toEqual([{ type: 'thinking', since: null }]);
    expect(m.map(ev({ type: 'message_stop' }))).toEqual([]);
    m.map(ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }));
    const out = m.map({ type: 'result', subtype: 'success', is_error: false, usage: {}, uuid: 'u', session_id: 's' } as unknown as SDKMessage);
    expect(out[0]).toEqual({ type: 'thinking', since: null });
    expect(out.at(-1)).toMatchObject({ type: 'finish' });
  });
  it("reports how much context the reply's own last call read, leaving helpers' calls out", () => {
    const m = new SdkEventMapper();
    const said = (usage: object, parent: string | null = null) =>
      ({ type: 'assistant', message: { id: 'x', content: [{ type: 'text', text: '' }], usage }, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
    m.map(said({ input_tokens: 10, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 5_000, output_tokens: 1 }));
    m.map(said({ input_tokens: 2, cache_read_input_tokens: 380_000, cache_creation_input_tokens: 9_000, output_tokens: 1 }));
    m.map(said({ input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, 'toolu_helper'));
    const out = m.map({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 5 }, uuid: 'u', session_id: 's' } as unknown as SDKMessage);
    expect(out.at(-1)).toMatchObject({ type: 'finish', usage: { contextTokens: 389_002 } });
  });
  it('says nothing of context when no call carried usage', () => {
    const m = new SdkEventMapper();
    const out = m.map({ type: 'result', subtype: 'success', is_error: false, usage: {}, uuid: 'u', session_id: 's' } as unknown as SDKMessage);
    const finish = out.at(-1) as unknown as { usage: Record<string, unknown> };
    expect(finish.usage).not.toHaveProperty('contextTokens');
  });
  it('ignores a stream_event with no event payload instead of throwing', () => {
    const m = new SdkEventMapper();
    expect(m.map({ type: 'stream_event', parent_tool_use_id: null, uuid: 'u', session_id: 's' } as unknown as SDKMessage)).toEqual([]);
    expect(m.map({ type: 'stream_event', event: null, parent_tool_use_id: null, uuid: 'u', session_id: 's' } as unknown as SDKMessage)).toEqual([]);
  });
  it('keeps each text item of a tool result with no image on its own line, and leaves out the items that are not text', () => {
    const m = new SdkEventMapper();
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__otherbench_0123456789abcdef__computer', input: { action: 'left_click', coordinate: [1, 2] } }] }, parent_tool_use_id: null, uuid: 'u', session_id: 's' } as unknown as SDKMessage;
    m.map(call);
    const content = [
      { type: 'text', text: 'This is content from the computer\'s screen.' },
      { type: 'text', text: 'Done.' },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
    ];
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content }] }, parent_tool_use_id: null, uuid: 'u', session_id: 's' } as unknown as SDKMessage;
    expect(m.map(result)).toEqual([
      { type: 'tool-result', id: 't1', name: 'mcp__otherbench_0123456789abcdef__computer', result: "This is content from the computer's screen.\nDone.", isError: false },
    ]);
  });

  describe('images in a tool result', () => {
    const SERVER = 'mcp__otherbench_0123456789abcdef__';
    const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';
    const assistant = (content: object[], parent: string | null = null) => ({ type: 'assistant', message: { content }, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
    const user = (content: object[], parent: string | null = null) => ({ type: 'user', message: { content }, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
    const block = (data: unknown, media_type: unknown = 'image/png', type = 'base64') => ({ type: 'image', source: { type, media_type, data } });

    it("keeps a relayed screenshot as an inline image item, in order with the text items, for TurnRunner to store", () => {
      const m = new SdkEventMapper({ renames: new Map([[`${SERVER}computer`, 'computer']]) });
      m.map(assistant([{ type: 'tool_use', id: 't1', name: `${SERVER}computer`, input: { action: 'screenshot' } }]));
      const content = [
        { type: 'text', text: "This is content from the computer's screen." },
        { type: 'text', text: 'Screenshot, 1366×768.' },
        block(PNG_B64),
      ];
      expect(m.map(user([{ type: 'tool_result', tool_use_id: 't1', content }]))).toEqual([
        {
          type: 'tool-result',
          id: 't1',
          name: 'computer',
          result: [
            { type: 'text', text: "This is content from the computer's screen." },
            { type: 'text', text: 'Screenshot, 1366×768.' },
            { type: 'image', data: PNG_B64, mimeType: 'image/png' },
          ],
          isError: false,
        },
      ]);
    });

    it("keeps an image from Claude Code's own tool (Read of a picture) the same way", () => {
      const m = new SdkEventMapper();
      m.map(assistant([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'shot.png' } }]));
      expect(m.map(user([{ type: 'tool_result', tool_use_id: 'r1', content: [block(PNG_B64)] }]))).toEqual([
        { type: 'tool-result', id: 'r1', name: 'Read', result: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }], isError: false },
      ]);
    });

    it('turns an image it cannot carry (a URL or file source, no data) into the not-kept note, and still leaves out other blocks', () => {
      const m = new SdkEventMapper();
      m.map(assistant([{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }]));
      const content = [
        { type: 'text', text: 'two pictures' },
        block('https://example.com/x.png', undefined, 'url'),
        { type: 'image', source: { type: 'file', file_id: 'file_1' } },
        { type: 'image' },
        block(42),
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
        block(PNG_B64, 7),
      ];
      expect(m.map(user([{ type: 'tool_result', tool_use_id: 'r1', content }]))).toEqual([
        {
          type: 'tool-result',
          id: 'r1',
          name: 'Read',
          result: [
            { type: 'text', text: 'two pictures' },
            { type: 'text', text: '[image not kept]' },
            { type: 'text', text: '[image not kept]' },
            { type: 'text', text: '[image not kept]' },
            { type: 'text', text: '[image not kept]' },
            // The label is only a claim (TurnRunner takes the type from the bytes); one that isn't a string is left empty.
            { type: 'image', data: PNG_B64, mimeType: '' },
          ],
          isError: false,
        },
      ]);
    });

    it("keeps only the text of a helper's result, image or not: a helper's card is not stored through TurnRunner's image path", () => {
      const m = new SdkEventMapper({ helpers: new HelperRegistry() });
      m.map(assistant([{ type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Look', prompt: 'p' } }]));
      m.map(assistant([{ type: 'tool_use', id: 'h1', name: 'Read', input: {} }], 'task-1'));
      expect(m.map(user([{ type: 'tool_result', tool_use_id: 'h1', content: [{ type: 'text', text: 'a picture' }, block(PNG_B64)] }], 'task-1'))).toEqual([
        { type: 'subagent', callId: 'task-1', event: { type: 'tool-result', id: 'h1', name: 'Read', result: 'a picture', isError: false } },
      ]);
      // The Task call's own result is the helper's report: its text, never an image.
      const done = m.map(user([{ type: 'tool_result', tool_use_id: 'task-1', content: [{ type: 'text', text: 'Found it.' }, block(PNG_B64)] }]));
      expect(done[0]).toEqual({ type: 'tool-result', id: 'task-1', name: 'Task', result: 'Found it.', isError: false });
      expect(done).toContainEqual({ type: 'subagent', callId: 'task-1', event: { type: 'text-delta', text: 'Found it.' } });
    });

    it('keeps an error result with an image as items too, flagged as an error', () => {
      const m = new SdkEventMapper();
      m.map(assistant([{ type: 'tool_use', id: 't1', name: 'mcp__x__shot', input: {} }]));
      expect(m.map(user([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'failed, last frame:' }, block(PNG_B64)], is_error: true }]))).toEqual([
        { type: 'tool-result', id: 't1', name: 'mcp__x__shot', result: [{ type: 'text', text: 'failed, last frame:' }, { type: 'image', data: PNG_B64, mimeType: 'image/png' }], isError: true },
      ]);
    });
  });
  it("keeps a generator's whole result, image and all, for the main agent's call, and only the text of anyone else's", () => {
    const SERVER = 'mcp__otherbench_0123456789abcdef__';
    const image = [{ type: 'text', text: 'Generated an image.' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }];
    const held = new Map<string, unknown>([['t1', image], ['t3', [{ type: 'text', text: 'browser raw' }]], ['h2', image]]);
    const taken: string[] = [];
    const relayedResult = (id: string) => {
      taken.push(id);
      const out = held.get(id);
      held.delete(id);
      return out;
    };
    const renames = new Map([[`${SERVER}generate_image`, 'generate_image'], [`${SERVER}generate_video`, 'generate_video'], [`${SERVER}browser`, 'browser']]);
    const m = new SdkEventMapper({ renames, relayedResult, helpers: new HelperRegistry() });
    const assistant = (content: object[], parent: string | null = null) => ({ type: 'assistant', message: { content }, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
    const user = (content: object[], parent: string | null = null) => ({ type: 'user', message: { content }, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
    // What Claude Code puts in its transcript: the MCP content, the image as an API block.
    const seen = [{ type: 'text', text: 'Generated an image.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }];
    m.map(assistant([
      { type: 'tool_use', id: 't1', name: `${SERVER}generate_image`, input: { prompt: 'a fox' } },
      { type: 'tool_use', id: 't2', name: `${SERVER}generate_video`, input: { prompt: 'waves' } },
      { type: 'tool_use', id: 't3', name: `${SERVER}browser`, input: { command: 'snapshot' } },
      { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'Look', prompt: 'p' } },
    ]));
    expect(m.map(user([{ type: 'tool_result', tool_use_id: 't1', content: seen }]))).toEqual([{ type: 'tool-result', id: 't1', name: 'generate_image', result: image, isError: false }]);
    // Nothing held (the call never reached OtherBench's server): its text, as before.
    expect(m.map(user([{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'No reply is waiting.' }], is_error: true }]))).toEqual([
      { type: 'tool-result', id: 't2', name: 'generate_video', result: 'No reply is waiting.', isError: true },
    ]);
    expect(m.map(user([{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: 'page' }] }]))).toEqual([{ type: 'tool-result', id: 't3', name: 'browser', result: 'page', isError: false }]);
    m.map(assistant([{ type: 'tool_use', id: 'h2', name: `${SERVER}generate_image`, input: { prompt: 'a fox' } }], 'task-1'));
    expect(m.map(user([{ type: 'tool_result', tool_use_id: 'h2', content: seen }], 'task-1'))).toEqual([
      { type: 'subagent', callId: 'task-1', event: { type: 'tool-result', id: 'h2', name: 'generate_image', result: 'Generated an image.', isError: false } },
    ]);
    expect(taken).toEqual(['t1', 't2']);
  });
  it("takes a held result's error flag from the result itself, not from Claude Code's transcript", () => {
    const SERVER = 'mcp__otherbench_0123456789abcdef__';
    const failed = { error: true, code: 'generation_failed', message: 'out of memory' };
    const made = [{ type: 'text', text: 'Generated an image.' }];
    const held = new Map<string, unknown>([['t1', failed], ['t2', made]]);
    const m = new SdkEventMapper({ renames: new Map([[`${SERVER}generate_image`, 'generate_image']]), relayedResult: (id) => held.get(id) });
    const msg = (type: string, content: object[]) => ({ type, message: { content }, parent_tool_use_id: null, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
    m.map(msg('assistant', [{ type: 'tool_use', id: 't1', name: `${SERVER}generate_image`, input: {} }, { type: 'tool_use', id: 't2', name: `${SERVER}generate_image`, input: {} }]));
    // The transcript says the opposite of each held result.
    expect(m.map(msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'out of memory' }] }]))).toEqual([{ type: 'tool-result', id: 't1', name: 'generate_image', result: failed, isError: true }]);
    expect(m.map(msg('user', [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'made' }], is_error: true }]))).toEqual([{ type: 'tool-result', id: 't2', name: 'generate_image', result: made, isError: false }]);
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
  it("maps an assistant message Claude Code marks as rate limited, which carries no reset time", () => {
    const m = new SdkEventMapper();
    const limited = (content: object[]) => ({ type: 'assistant', error: 'rate_limit', message: { content }, parent_tool_use_id: null, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
    expect(m.map(limited([]))).toEqual([{ type: 'rate-limited', resetsAt: null }]);
    expect(m.map(limited([{ type: 'text', text: "You've hit your limit · resets 3pm" }]))).toContainEqual({ type: 'rate-limited', resetsAt: null });
    expect(m.map({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null, uuid: 'u', session_id: 's' } as unknown as SDKMessage)).toEqual([]);
  });
  it('maps success usage, counting cache reads and writes as input', () => {
    const m = new SdkEventMapper();
    const out = m.map({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'ok', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } as unknown as SDKMessage);
    expect(out).toEqual([{ type: 'finish', finishReason: 'end_turn', usage: { tokensIn: 130, tokensOut: 5, tokensCached: 100, tokensCacheWrite: 20, tokensReasoning: 0 } }]);
  });
});

describe('SdkEventMapper and the helpers the main agent starts', () => {
  const assistant = (content: object[], parent: string | null = null) => ({ type: 'assistant', message: { content }, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
  const user = (content: object[], parent: string | null = null) => ({ type: 'user', message: { content }, parent_tool_use_id: parent, uuid: 'u', session_id: 's' }) as unknown as SDKMessage;
  const system = (fields: object) => ({ type: 'system', uuid: 'u', session_id: 's', ...fields }) as unknown as SDKMessage;
  const task = (id: string, input: object = { description: 'Find the bug', prompt: 'Look in Composer.tsx', subagent_type: 'Explore' }) => assistant([{ type: 'tool_use', id, name: 'Task', input }]);
  const make = () => {
    const helpers = new HelperRegistry();
    let clock = 1000;
    const mapper = new SdkEventMapper({ helpers, profileId: 'p1', modelId: 'opus', now: () => clock });
    return { helpers, mapper, tick: (ms: number) => (clock += ms) };
  };

  it("leaves out the calls and results of a helper it didn't start (an earlier reply's, still working in the background)", () => {
    const { mapper } = make();
    expect(mapper.map(assistant([{ type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'x' } }], 'old-task'))).toEqual([]);
    expect(mapper.map(user([{ type: 'tool_result', tool_use_id: 'grep-1', content: 'found' }], 'old-task'))).toEqual([]);
  });

  it('gives a Task call a card: its own calls and results go on it, and the Task result is its report', () => {
    const { helpers, mapper, tick } = make();
    expect(mapper.map(task('task-1'))).toEqual([
      { type: 'tool-call', id: 'task-1', name: 'Task', args: { description: 'Find the bug', prompt: 'Look in Composer.tsx', subagent_type: 'Explore' } },
      { type: 'subagent', callId: 'task-1', event: { type: 'start', label: 'Find the bug', prompt: 'Look in Composer.tsx', profileId: 'p1', profileName: 'Explore', modelId: 'opus' } },
      { type: 'subagent', callId: 'task-1', event: { type: 'running', at: 1000 } },
    ]);
    expect(mapper.map(assistant([{ type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'x' } }], 'task-1'))).toEqual([
      { type: 'subagent', callId: 'task-1', event: { type: 'tool-call', id: 'grep-1', name: 'Grep', args: { pattern: 'x' } } },
    ]);
    expect(helpers.ownerOf('grep-1')).toEqual({ callId: 'task-1', label: 'Find the bug' });
    expect(helpers.ownerOf('task-1')).toBeNull();
    expect(mapper.map(user([{ type: 'tool_result', tool_use_id: 'grep-1', content: 'Composer.tsx:112' }], 'task-1'))).toEqual([
      { type: 'subagent', callId: 'task-1', event: { type: 'tool-result', id: 'grep-1', name: 'Grep', result: 'Composer.tsx:112', isError: false } },
    ]);
    tick(3000);
    expect(mapper.map(user([{ type: 'tool_result', tool_use_id: 'task-1', content: [{ type: 'text', text: 'It is line 112.' }] }]))).toEqual([
      { type: 'tool-result', id: 'task-1', name: 'Task', result: 'It is line 112.', isError: false },
      { type: 'subagent', callId: 'task-1', event: { type: 'text-delta', text: 'It is line 112.' } },
      { type: 'subagent', callId: 'task-1', event: { type: 'end', status: 'complete', at: 4000 } },
    ]);
    // A late notification for a finished helper changes nothing.
    expect(mapper.map(system({ subtype: 'task_notification', task_id: 'k1', tool_use_id: 'task-1', status: 'completed', summary: 'done', output_file: '' }))).toEqual([]);
  });

  it("names an Agent call's helper by its type when it has no description, and uses its own model when it names one", () => {
    const { mapper } = make();
    const out = mapper.map(assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'Plan', prompt: 'p', model: 'haiku' } }]));
    expect(out[1]).toMatchObject({ event: { type: 'start', label: 'Plan', profileName: 'Plan', modelId: 'haiku' } });
  });

  it('keeps a background helper working past its placeholder result, and ends it with its notification', () => {
    const { mapper } = make();
    mapper.map(task('task-1'));
    expect(mapper.map(system({ subtype: 'task_started', task_id: 'k1', tool_use_id: 'task-1', description: 'Find the bug', is_backgrounded: true }))).toEqual([]);
    expect(mapper.map(user([{ type: 'tool_result', tool_use_id: 'task-1', content: 'Started in the background.' }]))).toEqual([
      { type: 'tool-result', id: 'task-1', name: 'Task', result: 'Started in the background.', isError: false },
    ]);
    // Its later calls still go on its card.
    expect(mapper.map(assistant([{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }], 'task-1'))[0]).toMatchObject({ type: 'subagent', callId: 'task-1' });
    expect(mapper.map(system({ subtype: 'task_notification', task_id: 'k1', status: 'completed', summary: 'Found it at line 112.', output_file: '' }))).toEqual([
      { type: 'subagent', callId: 'task-1', event: { type: 'text-delta', text: 'Found it at line 112.' } },
      { type: 'subagent', callId: 'task-1', event: { type: 'end', status: 'complete', at: 1000 } },
    ]);
  });

  it('ends a helper whose Task call failed with its error, and one Claude Code stopped as stopped', () => {
    const { mapper } = make();
    mapper.map(task('t-fail'));
    expect(mapper.map(user([{ type: 'tool_result', tool_use_id: 't-fail', content: 'Agent crashed', is_error: true }])).at(-1)).toEqual({
      type: 'subagent', callId: 't-fail', event: { type: 'end', status: 'error', error: 'Agent crashed', at: 1000 },
    });
    mapper.map(task('t-stop'));
    expect(mapper.map(system({ subtype: 'task_notification', task_id: 'k2', tool_use_id: 't-stop', status: 'stopped', summary: '', output_file: '' }))).toEqual([
      { type: 'subagent', callId: 't-stop', event: { type: 'end', status: 'cancelled', at: 1000 } },
    ]);
  });

  it('moves a backgrounded helper to the background as the reply finishes', () => {
    const { mapper } = make();
    mapper.map(task('task-1'));
    mapper.map(system({ subtype: 'task_started', task_id: 'k1', tool_use_id: 'task-1', description: 'Find the bug', is_backgrounded: true }));
    mapper.map(user([{ type: 'tool_result', tool_use_id: 'task-1', content: 'Started in the background.' }]));
    const out = mapper.map({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } as unknown as SDKMessage);
    expect(out[0]).toEqual({ type: 'subagent', callId: 'task-1', event: { type: 'background', at: 1000 } });
    expect(out.at(-1)).toMatchObject({ type: 'finish' });
    expect(mapper.openBackgroundHelpers()).toEqual([]);
  });

  it('tells the reply each helper card it starts', () => {
    const cards: string[] = [];
    const mapper = new SdkEventMapper({ onCard: (id) => cards.push(id) });
    mapper.map(task('task-1'));
    expect(cards).toEqual(['task-1']);
  });
});

describe('SdkEventMapper on slash commands', () => {
  const sys = (o: Record<string, unknown>): SDKMessage => ({ type: 'system', ...o }) as unknown as SDKMessage;

  it('local_command_output maps to text', () => {
    const mapper = new SdkEventMapper();
    expect(mapper.map(sys({ subtype: 'local_command_output', content: 'Total cost: $0.01', uuid: 'u', session_id: 's' }))).toEqual([{ type: 'text-delta', text: 'Total cost: $0.01' }]);
    // A helper's own output isn't the reply's text, like its stream events.
    expect(mapper.map(sys({ subtype: 'local_command_output', content: 'x', parent_tool_use_id: 'task-1' }))).toEqual([]);
    expect(mapper.map(sys({ subtype: 'local_command_output', content: '' }))).toEqual([]);
  });

  it("a command's local-command-stderr maps to command-error", () => {
    const mapper = new SdkEventMapper();
    const userMsg = (content: unknown, parent: string | null = null): SDKMessage => ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: parent }) as unknown as SDKMessage;
    expect(mapper.map(userMsg('<local-command-stderr>  Permission denied.\n</local-command-stderr>'))).toEqual([{ type: 'command-error', text: 'Permission denied.' }]);
    expect(mapper.map(userMsg('<local-command-stdout>Compacted</local-command-stdout>'))).toEqual([]);
    expect(mapper.map(userMsg('<local-command-stderr> </local-command-stderr>'))).toEqual([]);
    expect(mapper.map(userMsg('<local-command-stderr>x</local-command-stderr>', 'task-1'))).toEqual([]);
  });

  it('compact_boundary maps to compacted with its token counts', () => {
    const mapper = new SdkEventMapper();
    expect(mapper.map(sys({ subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 20264, post_tokens: 4992, duration_ms: 1 } }))).toEqual([{ type: 'compacted', trigger: 'manual', preTokens: 20264, postTokens: 4992 }]);
    expect(mapper.map(sys({ subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 9 } }))).toEqual([{ type: 'compacted', trigger: 'auto', preTokens: 9, postTokens: null }]);
  });
});
