import { describe, it, expect } from 'vitest';
import type { CanonMessage, EngineMeta, Part } from '../src/types/messages.js';
import { COMPACT_PREAMBLE, contextLineOf, contextPart, cutAtContextLine, isClearName, parseContextCommand } from '../src/domain/context-lines.js';

let n = 0;
function msg(id: string, role: 'user' | 'assistant', parts: Part[], extra: Partial<CanonMessage> = {}): CanonMessage {
  return { id, chatId: 'c', parentId: null, role, parts, status: 'complete', error: null, producedBy: null, createdAt: ++n, ...extra };
}
const text = (t: string): Part => ({ type: 'text', text: t });
const u = (id: string) => msg(id, 'user', [text(id)]);
const a = (id: string) => msg(id, 'assistant', [text(id)]);
const clear = (id: string) => msg(id, 'user', [contextPart({ kind: 'clear' })]);
const compact = (id: string) => msg(id, 'user', [contextPart({ kind: 'compact', focus: '' })]);
const X = { engine: 'claude_code', sessionId: 's' } as unknown as EngineMeta;
const reply = (id: string, summary = 'S') => msg(id, 'assistant', [{ type: 'context-summary', text: summary }], { engineMeta: X });
const ids = (p: CanonMessage[]) => p.map((m) => m.id);

describe('parseContextCommand', () => {
  it('recognises clear and its aliases', () => {
    for (const t of ['/clear', '  /clear  ', '/reset', '/new']) expect(parseContextCommand(t)).toEqual({ kind: 'clear' });
  });
  it('recognises compact with a focus', () => {
    expect(parseContextCommand('/compact')).toEqual({ kind: 'compact', focus: '' });
    expect(parseContextCommand('/compact keep the API notes')).toEqual({ kind: 'compact', focus: 'keep the API notes' });
  });
  it('in any case', () => {
    for (const t of ['/Clear', '/CLEAR', '/Reset', '/NEW']) expect(parseContextCommand(t)).toEqual({ kind: 'clear' });
    expect(parseContextCommand('/Compact Keep it')).toEqual({ kind: 'compact', focus: 'Keep it' });
  });
  it('a clear name with text after it is clear-with-text, never plain text', () => {
    for (const t of ['/clear now', '/Clear now', '/reset all of it', '/NEW chat', '/clear\nand more'])
      expect(parseContextCommand(t)).toEqual({ kind: 'clear-with-text' });
  });
  it('leaves everything else alone', () => {
    for (const t of ['/clearly', '/compactify', 'please /clear', '/newer', '/clear:x']) expect(parseContextCommand(t)).toBeNull();
  });
});

describe('isClearName', () => {
  it('is clear, reset or new in any case', () => {
    for (const n of ['clear', 'Clear', 'RESET', 'new']) expect(isClearName(n)).toBe(true);
    for (const n of ['compact', 'clearly', 'review']) expect(isClearName(n)).toBe(false);
  });
});

describe('contextLineOf', () => {
  it('reads a user context part, and nothing else', () => {
    expect(contextLineOf(compact('c'))).toEqual({ kind: 'compact' });
    expect(contextLineOf(u('x'))).toBeNull();
  });
});

describe('cutAtContextLine', () => {
  it('cuts after a clear', () => {
    expect(ids(cutAtContextLine([u('u1'), a('a1'), clear('c'), u('u2')]))).toEqual(['u2']);
  });
  it('swaps a compact and its reply for the preamble and the summary', () => {
    const r = reply('r');
    const out = cutAtContextLine([u('u1'), a('a1'), compact('c'), r, u('u2')]);
    expect(ids(out)).toEqual(['c', 'r', 'u2']);
    expect(out[0]!.parts).toEqual([{ type: 'text', text: COMPACT_PREAMBLE }]);
    expect(out[1]!.parts).toEqual([{ type: 'text', text: 'S' }]);
    expect(out[1]!.engineMeta).toBe(X);
  });
  it('the latest line wins', () => {
    const out = cutAtContextLine([u('u1'), clear('c1'), u('u2'), a('a2'), compact('c2'), reply('r'), u('u3')]);
    expect(ids(out)).toEqual(['c2', 'r', 'u3']);
  });
  it('a failed compact cuts nothing', () => {
    const failed = msg('r', 'assistant', [], { status: 'error' });
    const path = [u('u1'), a('a1'), compact('c'), failed, u('u2')];
    expect(cutAtContextLine(path)).toEqual(path);
    expect(ids(cutAtContextLine([u('u0'), clear('k'), ...path]))).toEqual(['u1', 'a1', 'c', 'r', 'u2']);
  });
  it('never treats the message being answered as a line', () => {
    const path = [u('u1'), a('a1'), compact('c')];
    expect(cutAtContextLine(path)).toEqual(path);
  });
  it('leaves a path with no line unchanged', () => {
    const path = [u('u1'), a('a1'), u('u2')];
    expect(cutAtContextLine(path)).toEqual(path);
  });
});
