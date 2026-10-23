import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/ports/tool-provider.js';
import type { Part } from '../src/types/messages.js';
import {
  ASK_TOOL,
  PLAN_APPROVED,
  PLAN_TOOL,
  STOPPED_ASK,
  UNATTENDED_PLAN,
  UNATTENDED_QUESTION,
  DECLINED_QUESTION,
  answersByQuestion,
  askReplyProblem,
  createPlanGate,
  isInvalid,
  latestTodos,
  parsePlan,
  parseQuestions,
  parseTodos,
  planChangesText,
  planResultText,
  questionResultText,
  readTodos,
  runAskCommand,
  runPlanCommand,
  runTodoCommand,
  todoResultText,
  type AskFn,
} from '../src/domain/thread-tools.js';

const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'c1', messageId: 'm1', profileId: 'p1', workspaceRoot: null, signal: new AbortController().signal, ...o });
const option = (label: string) => ({ label, description: `${label} option` });
const question = (text: string, o: Record<string, unknown> = {}) => ({ question: text, header: 'Pick', options: [option('Red'), option('Blue')], multiSelect: false, ...o });
const todo = (content: string, status = 'pending') => ({ content, status, activeForm: `Doing ${content}` });

describe('parseTodos', () => {
  it('reads the whole list, defaulting a missing activeForm to the content', () => {
    expect(parseTodos({ todos: [todo('a', 'completed'), { content: 'b', status: 'in_progress' }] })).toEqual([
      { content: 'a', status: 'completed', activeForm: 'Doing a' },
      { content: 'b', status: 'in_progress', activeForm: 'b' },
    ]);
  });
  it('takes 50 steps of 300 characters, and refuses 51 steps or 301 characters', () => {
    expect(parseTodos({ todos: Array.from({ length: 50 }, (_, i) => todo(`${i}`)) })).toHaveLength(50);
    expect(isInvalid(parseTodos({ todos: Array.from({ length: 51 }, (_, i) => todo(`${i}`)) }))).toBe(true);
    expect(parseTodos({ todos: [{ ...todo('x'.repeat(300)), activeForm: 'y'.repeat(300) }] })).toHaveLength(1);
    expect(isInvalid(parseTodos({ todos: [todo('x'.repeat(301))] }))).toBe(true);
    expect(isInvalid(parseTodos({ todos: [{ ...todo('a'), activeForm: 'y'.repeat(301) }] }))).toBe(true);
  });
  it('refuses a bad status, an empty step or no list', () => {
    expect(isInvalid(parseTodos({ todos: [todo('a', 'done')] }))).toBe(true);
    expect(isInvalid(parseTodos({ todos: [todo('  ')] }))).toBe(true);
    expect(isInvalid(parseTodos({}))).toBe(true);
  });
});

describe('readTodos and latestTodos (display)', () => {
  it('reads a list longer than update_todos allows, trimming long texts, but not a malformed one', () => {
    expect(readTodos({ todos: Array.from({ length: 60 }, (_, i) => todo(`${i}`)) })).toHaveLength(60);
    expect(readTodos({ todos: [todo('x'.repeat(400))] })![0]!.content).toHaveLength(300);
    expect(readTodos({ todos: [{ content: 'a', status: 'weird' }] })).toBeNull();
    expect(readTodos('nope')).toBeNull();
  });
  it('is the last readable todo call of either name, skipping a malformed one', () => {
    const parts: Part[] = [
      { type: 'tool-call', id: 't1', name: 'update_todos', args: { todos: [todo('first')] } },
      { type: 'text', text: 'working' },
      { type: 'tool-call', id: 't2', name: 'TodoWrite', args: { todos: [todo('second', 'in_progress')] } },
      { type: 'tool-call', id: 't3', name: 'update_todos', args: { todos: 'broken' } },
      { type: 'tool-call', id: 't4', name: 'read_file', args: { path: 'x' } },
    ];
    expect(latestTodos(parts)).toEqual([{ content: 'second', status: 'in_progress', activeForm: 'Doing second' }]);
    expect(latestTodos([{ type: 'text', text: 'no list' }])).toBeNull();
  });
});

describe('parseQuestions', () => {
  it('reads 1 to 4 questions of 2 to 4 options, multiSelect defaulting to false', () => {
    const parsed = parseQuestions({ questions: [{ question: 'Which?', header: 'Pick', options: [option('A'), option('B')] }] });
    expect(parsed).toEqual([{ question: 'Which?', header: 'Pick', options: [option('A'), option('B')], multiSelect: false }]);
    expect(isInvalid(parseQuestions({ questions: [] }))).toBe(true);
    expect(isInvalid(parseQuestions({ questions: ['a', 'b', 'c', 'd', 'e'].map((q) => question(q)) }))).toBe(true);
    expect(isInvalid(parseQuestions({ questions: [question('a', { options: [option('A')] })] }))).toBe(true);
    expect(isInvalid(parseQuestions({ questions: [question('a', { options: ['A', 'B', 'C', 'D', 'E'].map(option) })] }))).toBe(true);
  });
  it('holds each text to its limit', () => {
    expect(Array.isArray(parseQuestions({ questions: [question('q'.repeat(1000), { header: 'h'.repeat(40) })] }))).toBe(true);
    expect(isInvalid(parseQuestions({ questions: [question('q'.repeat(1001))] }))).toBe(true);
    expect(isInvalid(parseQuestions({ questions: [question('q', { header: 'h'.repeat(41) })] }))).toBe(true);
    expect(isInvalid(parseQuestions({ questions: [question('q', { options: [option('l'.repeat(101)), option('B')] })] }))).toBe(true);
    expect(isInvalid(parseQuestions({ questions: [question('q', { options: [{ label: 'A', description: 'd'.repeat(501) }, option('B')] })] }))).toBe(true);
  });
  it('refuses two questions with the same text, since answers are matched by text', () => {
    expect(isInvalid(parseQuestions({ questions: [question('Same?'), question('Same?')] }))).toBe(true);
  });
});

describe('parsePlan', () => {
  it('takes up to 20,000 characters of plan', () => {
    expect(parsePlan({ plan: '1. Do it' })).toBe('1. Do it');
    expect(parsePlan({ plan: 'p'.repeat(20_000) })).toHaveLength(20_000);
    expect(isInvalid(parsePlan({ plan: 'p'.repeat(20_001) }))).toBe(true);
    expect(isInvalid(parsePlan({ plan: '  ' }))).toBe(true);
  });
});

describe('result texts', () => {
  const qs = [question('Which colour?'), question('Which sizes?', { multiSelect: true })] as never;
  it('maps answers to question texts, as Claude Code takes them (multi-select already joined)', () => {
    expect(answersByQuestion(qs, ['Blue', 'S, M'])).toEqual({ 'Which colour?': 'Blue', 'Which sizes?': 'S, M' });
  });
  it("answers in Claude Code's own wording, and says when the user skipped, nobody was there, or the turn stopped", () => {
    expect(questionResultText(qs, { reply: { answers: ['Blue', 'S, M'] } })).toBe(
      'User has answered your questions: "Which colour?"="Blue", "Which sizes?"="S, M". You can now continue with the user\'s answers in mind.'
    );
    expect(questionResultText(qs, { reply: { declined: true } })).toBe(DECLINED_QUESTION);
    expect(questionResultText(qs, { unattended: true })).toBe(UNATTENDED_QUESTION);
    expect(questionResultText(qs, { cancelled: true })).toBe(STOPPED_ASK);
  });
  it('words each plan outcome', () => {
    expect(planResultText({ reply: { approve: true } })).toBe(PLAN_APPROVED);
    expect(planResultText({ reply: { changes: ' smaller ' } })).toBe(planChangesText('smaller'));
    expect(planChangesText('smaller')).toBe("The user wants changes before you start: smaller. Revise the plan and propose it again; don't change anything yet.");
    expect(planResultText({ unattended: true })).toBe(UNATTENDED_PLAN);
    expect(planResultText({ cancelled: true })).toBe(STOPPED_ASK);
  });
  it('sums up a checklist', () => {
    expect(todoResultText([{ content: 'a', status: 'completed', activeForm: 'a' }, { content: 'b', status: 'pending', activeForm: 'b' }])).toContain('1 of 2 done');
  });
});

describe('askReplyProblem', () => {
  const ask = { kind: 'question' as const, toolName: ASK_TOOL, questions: [question('Which?')] as never };
  const plan = { kind: 'plan' as const, toolName: PLAN_TOOL, plan: '1. x' };
  it('accepts the right reply for each kind', () => {
    expect(askReplyProblem(ask, { answers: ['Blue'] })).toBeNull();
    expect(askReplyProblem(ask, { declined: true })).toBeNull();
    expect(askReplyProblem(plan, { approve: true })).toBeNull();
    expect(askReplyProblem(plan, { changes: 'smaller' })).toBeNull();
  });
  it('refuses the wrong kind, a missing or empty answer, and over-long text', () => {
    expect(askReplyProblem(ask, { approve: true })).toMatch(/question/);
    expect(askReplyProblem(plan, { answers: ['x'] })).toMatch(/plan/);
    expect(askReplyProblem(ask, { answers: [] })).not.toBeNull();
    expect(askReplyProblem(ask, { answers: ['  '] })).not.toBeNull();
    expect(askReplyProblem(ask, { answers: ['a'.repeat(4001)] })).toMatch(/4000/);
    expect(askReplyProblem(plan, { changes: 'c'.repeat(8001) })).toMatch(/8000/);
    expect(askReplyProblem(plan, { changes: ' ' })).not.toBeNull();
  });
  describe('a generation ask', () => {
    const gen = { kind: 'generation' as const, toolName: 'generate_image', media: 'image' as const, prompt: 'a cat', negativePrompt: null, settings: '1024×1024 · seed 42' };
    it('takes a cancel or a prompt to generate', () => {
      expect(askReplyProblem(gen, { declined: true })).toBeNull();
      expect(askReplyProblem(gen, { generate: { prompt: 'a cat', negativePrompt: null } })).toBeNull();
      expect(askReplyProblem(gen, { generate: { prompt: 'a cat', negativePrompt: 'blurry' } })).toBeNull();
    });
    it('refuses an empty or over-long prompt, an over-long negative prompt and any other reply', () => {
      expect(askReplyProblem(gen, { generate: { prompt: '   ', negativePrompt: null } })).toBe("The prompt can't be empty.");
      expect(askReplyProblem(gen, { generate: { prompt: 'a'.repeat(4001), negativePrompt: null } })).toBe('A prompt can be at most 4000 characters.');
      expect(askReplyProblem(gen, { generate: { prompt: 'a', negativePrompt: 'n'.repeat(4001) } })).toBe('A negative prompt can be at most 4000 characters.');
      expect(askReplyProblem(gen, { approve: true })).toBe('This is a generation: generate it, or cancel.');
      expect(askReplyProblem(gen, { answers: ['x'] })).toBe('This is a generation: generate it, or cancel.');
    });
    it('refuses a generate reply to a question or a plan', () => {
      const reply = { generate: { prompt: 'a', negativePrompt: null } };
      expect(askReplyProblem(ask, reply)).toMatch(/question/);
      expect(askReplyProblem(plan, reply)).toMatch(/plan/);
    });
  });
});

describe('runners', () => {
  it('update_todos answers with the counts, or a tool error past a limit', () => {
    expect(runTodoCommand({ todos: [todo('a', 'completed')] })).toContain('1 of 1 done');
    expect(runTodoCommand({ todos: Array.from({ length: 51 }, (_, i) => todo(`${i}`)) })).toMatchObject({ error: true, code: 'invalid_input' });
  });
  it('ask_user asks once with the parsed questions and answers in result text; bad input never asks', async () => {
    const ask = vi.fn<AskFn>(async () => ({ reply: { answers: ['Blue'] } }));
    expect(await runAskCommand(ask, ctx(), { questions: [question('Which colour?')] })).toContain('"Which colour?"="Blue"');
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c1' }), { kind: 'question', toolName: ASK_TOOL, questions: [expect.objectContaining({ question: 'Which colour?' })] });
    expect(await runAskCommand(ask, ctx(), { questions: [] })).toMatchObject({ error: true, code: 'invalid_input' });
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it('propose_plan opens the gate only on approval', async () => {
    const gate = createPlanGate();
    const changes = vi.fn<AskFn>(async () => ({ reply: { changes: 'smaller' } }));
    expect(await runPlanCommand(changes, ctx({ plan: gate }), { plan: '1. x' })).toBe(planChangesText('smaller'));
    expect(gate.approved).toBe(false);
    const approve = vi.fn<AskFn>(async () => ({ reply: { approve: true } }));
    expect(await runPlanCommand(approve, ctx({ plan: gate }), { plan: '1. x' })).toBe(PLAN_APPROVED);
    expect(gate.approved).toBe(true);
    expect(approve).toHaveBeenCalledWith(expect.anything(), { kind: 'plan', toolName: PLAN_TOOL, plan: '1. x' });
  });
  it('runPlanCommand in an unattended run returns the unattended text and keeps the gate closed', async () => {
    const gate = createPlanGate();
    const ask = vi.fn<AskFn>(async () => ({ unattended: true }));
    expect(await runPlanCommand(ask, ctx({ plan: gate, unattended: true }), { plan: '1. x' })).toBe(UNATTENDED_PLAN);
    expect(gate.approved).toBe(false);
  });
});
