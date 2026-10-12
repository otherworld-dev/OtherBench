import { describe, expect, it } from 'vitest';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import { HISTORY_CHAR_LIMIT, renderHistory } from '../src/history.js';

const m = (id: string, role: CanonMessage['role'], parts: Part[], producedBy: CanonMessage['producedBy'] = null): CanonMessage => ({ id, chatId: 'c', parentId: null, role, parts, status: 'complete', error: null, producedBy, createdAt: 0 });

describe('renderHistory', () => {
  it('keeps questions and plans with their outcomes in a seeded history', () => {
    const out = renderHistory([
      m('u1', 'user', [{ type: 'text', text: 'paint it' }]),
      m('a1', 'assistant', [
        { type: 'tool-call', id: 'q1', name: 'AskUserQuestion', args: { questions: [{ question: 'Which colour?', header: 'C', options: [], multiSelect: false }] } },
        { type: 'tool-result', id: 'q1', name: 'AskUserQuestion', result: 'User has answered your questions: "Which colour?"="Blue".', isError: false },
        { type: 'tool-call', id: 'p1', name: 'propose_plan', args: { plan: '1. Paint it blue' } },
        { type: 'tool-result', id: 'p1', name: 'propose_plan', result: 'The user approved the plan. Go ahead with it.\nmore', isError: false },
      ]),
      m('u2', 'user', [{ type: 'text', text: 'next' }]),
    ]);
    expect(out).toContain('[asked: Which colour? -> User has answered your questions: "Which colour?"="Blue".]');
    expect(out).toContain('[plan -> The user approved the plan. Go ahead with it.]');
  });
  it('is empty for a first message', () => {
    expect(renderHistory([m('u1', 'user', [{ type: 'text', text: 'hi' }])])).toBe('');
  });
  it('renders prior turns, tool calls as one-liners, and skips system, reasoning and the last user message', () => {
    const out = renderHistory([
      m('s', 'system', [{ type: 'text', text: 'SYSTEM' }]),
      m('u1', 'user', [{ type: 'text', text: 'fix the bug' }]),
      m('a1', 'assistant', [
        { type: 'reasoning', text: 'secret thoughts' },
        { type: 'tool-call', id: 't1', name: 'edit_file', args: { path: 'src/a.ts' } },
        { type: 'tool-result', id: 't1', name: 'edit_file', result: { ok: true }, isError: false },
        { type: 'text', text: 'done' },
      ], { profileId: 'p', profileName: 'Qwen', connectionId: 'c', modelId: 'qwen3-coder:30b' }),
      m('u2', 'user', [{ type: 'text', text: 'now test it' }]),
    ]);
    expect(out).toContain('<grunt-history>');
    expect(out).toContain('[user] fix the bug');
    expect(out).toContain('[assistant: Qwen · qwen3-coder:30b]');
    expect(out).toContain('[tool edit_file src/a.ts -> ok]');
    expect(out).toContain('done');
    expect(out).not.toContain('SYSTEM');
    expect(out).not.toContain('secret thoughts');
    expect(out).not.toContain('now test it');
  });
  it('keeps only the most recent HISTORY_CHAR_LIMIT characters and marks the cut', () => {
    const big = 'x'.repeat(HISTORY_CHAR_LIMIT);
    const out = renderHistory([m('u1', 'user', [{ type: 'text', text: 'FIRST' + big }]), m('a1', 'assistant', [{ type: 'text', text: 'LAST' }]), m('u2', 'user', [{ type: 'text', text: 'q' }])]);
    expect(out).toContain('[earlier messages omitted]');
    expect(out).toContain('LAST');
    expect(out).not.toContain('FIRST');
    expect(out.length).toBeLessThan(HISTORY_CHAR_LIMIT + 500);
  });
});
