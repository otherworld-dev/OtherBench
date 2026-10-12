import { describe, expect, it } from 'vitest';
import { buildLiveArgs, canonicalJson, LIVE_ARTIFACTS_GUIDANCE, liveCallHash, normaliseLiveToolName, parseLiveSpec } from '../src/domain/live-artifacts.js';
import type { LiveCall } from '../src/ports/store.js';

/** The Mock model's declaration (spec §5). */
const MOCK = { calls: [{ id: 'value', tool: 'mcp__Fixture__lookup', args: { key: { $param: 'key' } }, params: { key: { enum: ['a', 'b'], default: 'a' } } }] };

const call = (over: Record<string, unknown> = {}) => ({ id: 'c', tool: 'mcp__s__t', args: {}, ...over });
const withParam = (p: unknown) => ({ calls: [call({ args: { k: { $param: 'p' } }, params: { p } })] });

function refused(raw: unknown): string {
  const r = parseLiveSpec(raw);
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.spec)}`);
  return r.message;
}

describe('parseLiveSpec', () => {
  it("accepts the mock's declaration as a JSON string and as an object, and fills in empty params", () => {
    expect(parseLiveSpec(JSON.stringify(MOCK))).toEqual({ ok: true, spec: MOCK });
    expect(parseLiveSpec(MOCK)).toEqual({ ok: true, spec: MOCK });
    expect(parseLiveSpec({ calls: [{ id: 'c', tool: 'mcp__s__t' }] })).toEqual({ ok: true, spec: { calls: [{ id: 'c', tool: 'mcp__s__t', args: {}, params: {} }] } });
  });

  it('reads {"calls":[]} as no declaration', () => {
    expect(parseLiveSpec('{"calls":[]}')).toEqual({ ok: true, spec: null });
  });

  it("stores Claude Code's relay names as the MCP tool's own name", () => {
    const r = parseLiveSpec({ calls: [call({ tool: 'mcp__grunt_0123456789abcdef__nextcloud__tasks_list' })] });
    expect(r.ok && r.spec?.calls[0]!.tool).toBe('mcp__nextcloud__tasks_list');
  });

  it('refuses each broken rule with a message naming the call and the rule', () => {
    expect(refused('{nope')).toMatch(/must be JSON/);
    expect(refused('"calls"')).toMatch(/must be an object/);
    expect(refused({ calls: [], extra: 1 })).toMatch(/unknown keys: extra/);
    expect(refused({ calls: {} })).toMatch(/"live.calls" must be a list/);
    expect(refused({ calls: Array.from({ length: 11 }, (_, i) => call({ id: `c${i}` })) })).toMatch(/at most 10 calls/);
    expect(refused({ calls: [call({ id: 'Bad_Id' })] })).toMatch(/"id" must be/);
    expect(refused({ calls: [call(), call()] })).toMatch(/live call "c": the id is used twice/);
    expect(refused({ calls: [call({ tool: 'read_file' })] })).toMatch(/live call "c": "read_file" isn't an MCP tool's name/);
    expect(refused({ calls: [call({ args: [1] })] })).toMatch(/"args" must be an object/);
    expect(refused({ calls: [call({ args: { blob: 'x'.repeat(5000) } })] })).toMatch(/"args" is over 4096 bytes/);
    expect(refused({ calls: [call({ args: { k: { $param: 'nope' } } })] })).toMatch(/names a param it doesn't declare/);
    expect(refused({ calls: [call({ params: { days: { type: 'integer', minimum: 1, maximum: 30, default: 7 } } })] })).toMatch(/param "days" is declared but no/);
    expect(refused({ calls: [call({ args: { k: { $param: 'p', other: 1 } }, params: { p: { enum: ['a'], default: 'a' } } })] })).toMatch(/can't have other keys/);
    expect(refused({ calls: [call({ when: 'now' })] })).toMatch(/live call "c" has unknown keys: when/);
    expect(refused(withParam({ enum: [], default: 'a' }))).toMatch(/1-50 values/);
    expect(refused(withParam({ enum: ['x'.repeat(201)], default: 'x' }))).toMatch(/at most 200 characters/);
    expect(refused(withParam({ enum: ['a', 1], default: 'a' }))).toMatch(/same type/);
    expect(refused(withParam({ enum: ['a', 'a'], default: 'a' }))).toMatch(/distinct/);
    expect(refused(withParam({ enum: ['a', 'b'], default: 'c' }))).toMatch(/default "c" is not one of/);
    expect(refused(withParam({ type: 'integer', minimum: 1, maximum: 30, default: 40 }))).toBe('live call "c": param "p" default 40 is outside 1-30.');
    expect(refused(withParam({ type: 'integer', minimum: 9, maximum: 1, default: 5 }))).toMatch(/"minimum" 9 is above "maximum" 1/);
    expect(refused(withParam({ type: 'integer', minimum: 1.5, maximum: 3, default: 2 }))).toMatch(/whole numbers/);
    expect(refused(withParam({ type: 'integer', minimum: 1, maximum: 30, default: 7, step: 2 }))).toMatch(/unknown keys: step/);
    expect(refused(withParam({ type: 'string' }))).toMatch(/must have "enum" or "type": "integer"/);
  });

  it('refuses more than 5 params on a call', () => {
    const params = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, { enum: ['a'], default: 'a' }]));
    const args = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, { $param: `p${i}` }]));
    expect(refused({ calls: [call({ args, params })] })).toMatch(/at most 5 params/);
  });

  it('refuses a declaration over 32 KB in all', () => {
    const big = Array.from({ length: 10 }, (_, i) => call({ id: `c${i}`, args: { blob: 'x'.repeat(3500) } }));
    expect(refused({ calls: big })).toMatch(/over 32 KB/);
  });
});

describe('normaliseLiveToolName', () => {
  it('maps the Claude Code relay form back and leaves other names alone', () => {
    expect(normaliseLiveToolName('mcp__grunt_0123456789abcdef__nextcloud__tasks_list')).toBe('mcp__nextcloud__tasks_list');
    expect(normaliseLiveToolName('mcp__nextcloud__tasks_list')).toBe('mcp__nextcloud__tasks_list');
    expect(normaliseLiveToolName('mcp__grunt_xyz__a__b')).toBe('mcp__grunt_xyz__a__b');
  });
});

describe('buildLiveArgs', () => {
  const DUE: LiveCall = {
    id: 'due',
    tool: 'mcp__s__t',
    args: { filter: { within: { $param: 'days' }, lists: [{ $param: 'list' }] }, fixed: true },
    params: { days: { type: 'integer', minimum: 1, maximum: 30, default: 7 }, list: { enum: ['Work', 'Home'], default: 'Work' } },
  };

  it('fills nested placeholders, and takes the default for a value the page leaves out', () => {
    expect(buildLiveArgs(DUE, { days: 14 })).toEqual({ ok: true, args: { filter: { within: 14, lists: ['Work'] }, fixed: true } });
    expect(buildLiveArgs(DUE, undefined)).toEqual({ ok: true, args: { filter: { within: 7, lists: ['Work'] }, fixed: true } });
    expect(buildLiveArgs(DUE, { list: 'Home' })).toEqual({ ok: true, args: { filter: { within: 7, lists: ['Home'] }, fixed: true } });
    // The declaration is never changed by filling it in.
    expect(DUE.args).toEqual({ filter: { within: { $param: 'days' }, lists: [{ $param: 'list' }] }, fixed: true });
  });

  it('refuses unknown names, out-of-range integers, enum misses and values of the wrong type, never coercing them', () => {
    expect(buildLiveArgs(DUE, { weeks: 2 })).toEqual({ ok: false, message: '"due" has no param "weeks".' });
    expect(buildLiveArgs(DUE, { days: 31 })).toEqual({ ok: false, message: 'param "days" must be a whole number from 1 to 30.' });
    expect(buildLiveArgs(DUE, { days: 2.5 })).toMatchObject({ ok: false });
    expect(buildLiveArgs(DUE, { days: '14' })).toMatchObject({ ok: false });
    expect(buildLiveArgs(DUE, { list: 'work' })).toEqual({ ok: false, message: 'param "list" must be one of: "Work", "Home".' });
    expect(buildLiveArgs(DUE, { list: 1 })).toMatchObject({ ok: false });
    expect(buildLiveArgs(DUE, [14])).toEqual({ ok: false, message: '"params" must be an object.' });
  });

  it('never coerces: strings for integers, numbers for string enums and strings for number or boolean enums are refused', () => {
    const MIXED: LiveCall = {
      id: 'm',
      tool: 'mcp__s__t',
      args: { n: { $param: 'n' }, flag: { $param: 'flag' }, size: { $param: 'size' }, days: { $param: 'days' } },
      params: {
        n: { enum: [1, 2], default: 1 },
        flag: { enum: [true, false], default: true },
        size: { enum: ['1', '2'], default: '1' },
        days: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
      },
    };
    for (const bad of [{ n: '1' }, { flag: 'true' }, { flag: 1 }, { size: 1 }, { days: '14' }, { days: true }, { days: null }, { days: [14] }, { days: Number.NaN }, { days: Infinity }]) {
      expect(buildLiveArgs(MIXED, bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(buildLiveArgs(MIXED, { n: 2, flag: false, size: '2', days: 30 })).toEqual({ ok: true, args: { n: 2, flag: false, size: '2', days: 30 } });
    // Non-object params of any kind are refused, not read as "all defaults".
    for (const bad of ['{"days":14}', 14, true, [], [14]]) expect(buildLiveArgs(MIXED, bad), JSON.stringify(bad)).toEqual({ ok: false, message: '"params" must be an object.' });
  });
});

describe('liveCallHash and canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: [2, 1], a: { d: 1, c: null } })).toBe('{"a":{"c":null,"d":1},"b":[2,1]}');
  });

  it('is stable under key order, ignores the call id, and changes with the tool or any argument', () => {
    const a: LiveCall = { id: 'x', tool: 'mcp__s__t', args: { a: 1, b: { c: 2, d: 3 } }, params: {} };
    const b: LiveCall = { id: 'y', tool: 'mcp__s__t', args: { b: { d: 3, c: 2 }, a: 1 }, params: {} };
    expect(liveCallHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(liveCallHash(a)).toBe(liveCallHash(b));
    expect(liveCallHash({ ...a, args: { a: 2, b: { c: 2, d: 3 } } })).not.toBe(liveCallHash(a));
    expect(liveCallHash({ ...a, tool: 'mcp__s__u' })).not.toBe(liveCallHash(a));
    expect(liveCallHash({ ...a, params: { p: { enum: ['a'], default: 'a' } } })).not.toBe(liveCallHash(a));
  });
});

describe('LIVE_ARTIFACTS_GUIDANCE', () => {
  it('tells the model how to declare calls, include the helper and treat tool data as data', () => {
    expect(LIVE_ARTIFACTS_GUIDANCE.startsWith('# Live artifacts')).toBe(true);
    expect(LIVE_ARTIFACTS_GUIDANCE).toContain('<script src="grunt-live.js"></script>');
    expect(LIVE_ARTIFACTS_GUIDANCE).toContain('textContent');
    expect(LIVE_ARTIFACTS_GUIDANCE).toContain('not_approved');
  });
});
