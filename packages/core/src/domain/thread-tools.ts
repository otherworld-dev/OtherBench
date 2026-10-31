import type { ToolContext } from '../ports/tool-provider.js';
import type { Part } from '../types/messages.js';
import type { AskInput, AskOutcome, AskReply, PlanGate, Question, QuestionOption, TodoItem, TodoStatus } from '../types/thread.js';

export type { AskInput, AskOutcome, AskReply, PlanGate, Question, QuestionOption, TodoItem, TodoStatus } from '../types/thread.js';

// Thread cards (spec docs/superpowers/specs/2026-10-12-thread-cards-design.md):
// the checklist, question and plan tools, the same for both engines. No Node
// imports: the web UI imports this module for its parsers and display helpers.

export const TODO_TOOL = 'update_todos';
export const ASK_TOOL = 'ask_user';
export const PLAN_TOOL = 'propose_plan';
/** Claude Code's own tools for the same jobs. */
export const AGENT_TODO_TOOL = 'TodoWrite';
export const AGENT_ASK_TOOL = 'AskUserQuestion';

export const TODO_MAX_ITEMS = 50;
export const TODO_MAX_TEXT = 300;
export const QUESTIONS_MAX = 4;
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;
export const QUESTION_MAX_CHARS = 1_000;
export const HEADER_MAX_CHARS = 40;
export const LABEL_MAX_CHARS = 100;
export const DESCRIPTION_MAX_CHARS = 500;
export const PLAN_MAX_CHARS = 20_000;
export const ANSWER_MAX_CHARS = 4_000;
export const CHANGES_MAX_CHARS = 8_000;
export const GENERATION_PROMPT_MAX_CHARS = 4_000;

/** Added to the user's message in the request only (never stored) while Plan mode is on. */
export const PLAN_MODE_NOTE =
  "(OtherBench: Plan mode is on for this message. Look around as much as you need, but before you change anything (files, commands, anything with side effects) set out your plan with the propose_plan tool and wait for the user's approval. Until they approve it, tools that change things are refused.)";
export const PLAN_REFUSAL = "Plan mode is on: set out your plan with propose_plan and wait for the user's approval before changing anything.";
export const PLAN_APPROVED = 'The user approved the plan. Go ahead with it; tools that change things still need their usual approvals.';
export const DECLINED_QUESTION = 'The user skipped your question. Carry on without their answer: use your judgement, and say in your reply what you assumed.';
export const UNATTENDED_QUESTION = 'Nobody is here to answer: this run is unattended. Use your judgement, carry on, and say in your reply what you assumed.';
export const UNATTENDED_PLAN = "Nobody can approve a plan in this run, so nothing may be changed. Don't propose it again; finish by setting out your plan in your reply.";
export const STOPPED_ASK = 'The turn was stopped before the user answered.';

export function planChangesText(note: string): string {
  return `The user wants changes before you start: ${note}. Revise the plan and propose it again; don't change anything yet.`;
}

export const TODO_TOOL_DESCRIPTION =
  'Keep a checklist of the steps of a longer task; the user sees it live under your reply. Send the whole list every time, each step pending, in_progress or completed. Keep one step in_progress while you work on it and mark steps completed as soon as they are done. Skip it for quick, one-step answers.';
export const ASK_TOOL_DESCRIPTION =
  "Ask the user one to four multiple-choice questions and wait for the answers. Use it only when you can't sensibly go on without the user's choice; otherwise make a reasonable assumption and say so. Each question has a short header, 2 to 4 options (a label and a description each), and multiSelect when more than one option may be chosen. The user can always type an answer of their own instead.";
export const PLAN_TOOL_DESCRIPTION =
  "Set out your plan in Markdown and wait for the user's approval. Call this when plan mode is on, before changing anything: until the plan is approved, tools that change things are refused. If the user asks for changes, revise the plan and propose it again.";

export const TODO_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      maxItems: TODO_MAX_ITEMS,
      description: 'The whole checklist, in order.',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The step, e.g. "Run the tests".' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string', description: 'The step while it runs, e.g. "Running the tests".' },
        },
        required: ['content', 'status', 'activeForm'],
      },
    },
  },
  required: ['todos'],
};

export const ASK_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: QUESTIONS_MAX,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The whole question, ending with a question mark.' },
          header: { type: 'string', description: 'A very short label for it, e.g. "Library".' },
          options: {
            type: 'array',
            minItems: OPTIONS_MIN,
            maxItems: OPTIONS_MAX,
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, description: { type: 'string' } },
              required: ['label', 'description'],
            },
          },
          multiSelect: { type: 'boolean' },
        },
        required: ['question', 'header', 'options', 'multiSelect'],
      },
    },
  },
  required: ['questions'],
};

export const PLAN_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: { plan: { type: 'string', description: 'The plan, in Markdown: numbered steps, and what each will change.' } },
  required: ['plan'],
};

/** A parser's refusal, worded for the model. */
export interface Invalid {
  invalid: string;
}

export function isInvalid(value: unknown): value is Invalid {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { invalid?: unknown }).invalid === 'string';
}

const invalid = (reason: string): Invalid => ({ invalid: reason });

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function text(value: unknown, key: string): string | null {
  const v = field(value, key);
  return typeof v === 'string' ? v : null;
}

const TODO_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed'];
const isTodoStatus = (v: unknown): v is TodoStatus => typeof v === 'string' && TODO_STATUSES.includes(v);

/** `update_todos` input, held to its limits. */
export function parseTodos(args: unknown): TodoItem[] | Invalid {
  const list = field(args, 'todos');
  if (!Array.isArray(list)) return invalid('"todos" must be the whole checklist, as a list of steps.');
  if (list.length > TODO_MAX_ITEMS) return invalid(`A checklist can have at most ${TODO_MAX_ITEMS} steps.`);
  const out: TodoItem[] = [];
  for (const raw of list) {
    const content = text(raw, 'content');
    const status = field(raw, 'status');
    const activeForm = text(raw, 'activeForm');
    if (content === null || content.trim() === '') return invalid('Each step needs its "content".');
    if (content.length > TODO_MAX_TEXT || (activeForm?.length ?? 0) > TODO_MAX_TEXT) return invalid(`Each step's text can be at most ${TODO_MAX_TEXT} characters.`);
    if (!isTodoStatus(status)) return invalid('Each step\'s "status" is pending, in_progress or completed.');
    out.push({ content, status, activeForm: activeForm !== null && activeForm.trim() !== '' ? activeForm : content });
  }
  return out;
}

/**
 * A todo call's list for display: Claude Code's `TodoWrite` isn't held to
 * `update_todos`' limits, so any length is read and long texts are cut.
 * Null when it isn't a list of well-formed steps.
 */
export function readTodos(args: unknown): TodoItem[] | null {
  const list = field(args, 'todos');
  if (!Array.isArray(list)) return null;
  const out: TodoItem[] = [];
  for (const raw of list) {
    const content = text(raw, 'content');
    const status = field(raw, 'status');
    if (content === null || !isTodoStatus(status)) return null;
    const activeForm = text(raw, 'activeForm');
    out.push({ content: content.slice(0, TODO_MAX_TEXT), status, activeForm: (activeForm !== null && activeForm.trim() !== '' ? activeForm : content).slice(0, TODO_MAX_TEXT) });
  }
  return out;
}

export const isTodoTool = (name: string): boolean => name === TODO_TOOL || name === AGENT_TODO_TOOL;
export const isAskTool = (name: string): boolean => name === ASK_TOOL || name === AGENT_ASK_TOOL;
export const isPlanTool = (name: string): boolean => name === PLAN_TOOL;

/** The reply's checklist: the last readable todo call of either name in its parts, or null. */
export function latestTodos(parts: readonly Part[]): TodoItem[] | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part?.type !== 'tool-call' || !isTodoTool(part.name)) continue;
    const todos = readTodos(part.args);
    if (todos) return todos;
  }
  return null;
}

/** `ask_user` / `AskUserQuestion` input, held to its limits (`preview` is dropped). */
export function parseQuestions(args: unknown): Question[] | Invalid {
  const list = field(args, 'questions');
  if (!Array.isArray(list) || list.length < 1 || list.length > QUESTIONS_MAX) return invalid(`Ask 1 to ${QUESTIONS_MAX} questions.`);
  const out: Question[] = [];
  for (const raw of list) {
    const question = text(raw, 'question');
    const header = text(raw, 'header') ?? '';
    const options = field(raw, 'options');
    if (question === null || question.trim() === '') return invalid('Each question needs its "question" text.');
    if (question.length > QUESTION_MAX_CHARS) return invalid(`A question can be at most ${QUESTION_MAX_CHARS} characters.`);
    if (header.length > HEADER_MAX_CHARS) return invalid(`A header can be at most ${HEADER_MAX_CHARS} characters.`);
    if (!Array.isArray(options) || options.length < OPTIONS_MIN || options.length > OPTIONS_MAX) return invalid(`Each question needs ${OPTIONS_MIN} to ${OPTIONS_MAX} options.`);
    const parsed: QuestionOption[] = [];
    for (const o of options) {
      const label = text(o, 'label');
      const description = text(o, 'description') ?? '';
      if (label === null || label.trim() === '') return invalid('Each option needs a "label".');
      if (label.length > LABEL_MAX_CHARS) return invalid(`An option's label can be at most ${LABEL_MAX_CHARS} characters.`);
      if (description.length > DESCRIPTION_MAX_CHARS) return invalid(`An option's description can be at most ${DESCRIPTION_MAX_CHARS} characters.`);
      parsed.push({ label, description });
    }
    if (new Set(parsed.map((o) => o.label)).size !== parsed.length) return invalid("A question's option labels must all be different.");
    out.push({ question, header, options: parsed, multiSelect: field(raw, 'multiSelect') === true });
  }
  if (new Set(out.map((q) => q.question)).size !== out.length) return invalid('Each question must be different: answers are matched to questions by their text.');
  return out;
}

/** `propose_plan` input. */
export function parsePlan(args: unknown): string | Invalid {
  const plan = text(args, 'plan');
  if (plan === null || plan.trim() === '') return invalid('"plan" must be your plan, in Markdown.');
  if (plan.length > PLAN_MAX_CHARS) return invalid(`A plan can be at most ${PLAN_MAX_CHARS} characters.`);
  return plan;
}

export function todoResultText(todos: readonly TodoItem[]): string {
  const done = todos.filter((t) => t.status === 'completed').length;
  return `Checklist updated: ${done} of ${todos.length} done. Keep it current as you work.`;
}

/** Question text to answer, the map Claude Code's `AskUserQuestion` takes as `answers`. */
export function answersByQuestion(questions: readonly Question[], answers: readonly string[]): Record<string, string> {
  return Object.fromEntries(questions.map((q, i) => [q.question, answers[i] ?? '']));
}

export function questionResultText(questions: readonly Question[], outcome: AskOutcome): string {
  if ('unattended' in outcome) return UNATTENDED_QUESTION;
  if ('cancelled' in outcome) return STOPPED_ASK;
  const reply = outcome.reply;
  if (!('answers' in reply)) return DECLINED_QUESTION;
  const pairs = questions.map((q, i) => `"${q.question}"="${reply.answers[i] ?? ''}"`).join(', ');
  return `User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`;
}

export function planResultText(outcome: AskOutcome): string {
  if ('unattended' in outcome) return UNATTENDED_PLAN;
  if ('cancelled' in outcome) return STOPPED_ASK;
  const reply = outcome.reply;
  if ('approve' in reply) return PLAN_APPROVED;
  if ('changes' in reply) return planChangesText(reply.changes.trim());
  return "The user didn't approve the plan. Don't change anything yet.";
}

/** Why `reply` can't answer `ask`, or null when it can. */
export function askReplyProblem(ask: AskInput, reply: AskReply): string | null {
  if (ask.kind === 'question') {
    if ('declined' in reply) return null;
    if (!('answers' in reply)) return 'This is a question: answer it, or skip it.';
    if (reply.answers.length !== ask.questions.length) return `Send one answer for each of the ${ask.questions.length} questions.`;
    for (const answer of reply.answers) {
      if (answer.trim() === '') return 'Every question needs an answer.';
      if (answer.length > ANSWER_MAX_CHARS) return `An answer can be at most ${ANSWER_MAX_CHARS} characters.`;
    }
    return null;
  }
  if (ask.kind === 'generation') {
    if ('declined' in reply) return null;
    if (!('generate' in reply)) return 'This is a generation: generate it, or cancel.';
    const { prompt, negativePrompt } = reply.generate;
    if (typeof prompt !== 'string' || prompt.trim() === '') return "The prompt can't be empty.";
    if (prompt.length > GENERATION_PROMPT_MAX_CHARS) return `A prompt can be at most ${GENERATION_PROMPT_MAX_CHARS} characters.`;
    if (negativePrompt !== null && (typeof negativePrompt !== 'string' || negativePrompt.length > GENERATION_PROMPT_MAX_CHARS)) {
      return `A negative prompt can be at most ${GENERATION_PROMPT_MAX_CHARS} characters.`;
    }
    return null;
  }
  if (ask.kind === 'browser') return 'approve' in reply || 'declined' in reply ? null : "This is the browser: say you're done, or skip it.";
  if ('approve' in reply) return null;
  if (!('changes' in reply)) return 'This is a plan: approve it, or ask for changes.';
  if (reply.changes.trim() === '') return 'Say what to change.';
  if (reply.changes.length > CHANGES_MAX_CHARS) return `Changes can be at most ${CHANGES_MAX_CHARS} characters.`;
  return null;
}

/** A reply's plan approval, closed until `approve()`. */
export function createPlanGate(): PlanGate {
  let approved = false;
  return {
    get approved() {
      return approved;
    },
    approve() {
      approved = true;
    },
  };
}

/** A thread tool's refusal of its input, as every OtherBench tool reports an error. */
export interface ThreadToolError {
  error: true;
  code: 'invalid_input';
  message: string;
}

const inputError = (message: string): ThreadToolError => ({ error: true, code: 'invalid_input', message });

/** `ToolProvider.askUser`'s signature. */
export type AskFn = (ctx: ToolContext, input: AskInput) => Promise<AskOutcome>;

/** `update_todos` (and Claude Code's fallback todo tool): nothing to wait for; the web reads the call itself. */
export function runTodoCommand(args: unknown): string | ThreadToolError {
  const todos = parseTodos(args);
  return isInvalid(todos) ? inputError(todos.invalid) : todoResultText(todos);
}

/** `ask_user`: raises a question card and waits for the answer. */
export async function runAskCommand(ask: AskFn, ctx: ToolContext, args: unknown): Promise<string | ThreadToolError> {
  const questions = parseQuestions(args);
  if (isInvalid(questions)) return inputError(questions.invalid);
  return questionResultText(questions, await ask(ctx, { kind: 'question', toolName: ASK_TOOL, questions }));
}

/** `propose_plan`: raises a plan card; an approval opens this reply's gate. */
export async function runPlanCommand(ask: AskFn, ctx: ToolContext, args: unknown): Promise<string | ThreadToolError> {
  const plan = parsePlan(args);
  if (isInvalid(plan)) return inputError(plan.invalid);
  const outcome = await ask(ctx, { kind: 'plan', toolName: PLAN_TOOL, plan });
  if ('reply' in outcome && 'approve' in outcome.reply) ctx.plan?.approve();
  return planResultText(outcome);
}
