/**
 * Thread cards (spec 2026-10-12-thread-cards-design): a reply's checklist,
 * the model's questions and its plan. Plain data, shared by the server and
 * the web UI.
 */

/** Where a checklist step stands. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One step of a reply's checklist: Claude Code's `TodoWrite` item, and `update_todos`'. */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** The step in the present continuous ("Running the tests"), shown while it is in progress. */
  activeForm: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

/** One multiple-choice question: Claude Code's `AskUserQuestion` shape, without `preview`. */
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** One reply's plan approval: closed until the user approves a plan, then open for the rest of that reply. */
export interface PlanGate {
  readonly approved: boolean;
  approve(): void;
}

/** What a tool asks the user: questions, or a plan to approve. `toolName` is the tool that asked. */
export type AskInput =
  | { kind: 'question'; toolName: string; questions: Question[] }
  | { kind: 'plan'; toolName: string; plan: string };

/** An ask waiting in the thread, tied to the reply that raised it. */
export type UserAsk = AskInput & { id: string; chatId: string; messageId: string };

/** The user's answer: one answer per question (multi-select joined with ", "), a skip, an approval, or changes. */
export type AskReply = { answers: string[] } | { declined: true } | { approve: true } | { changes: string };

/** How an ask ended: answered, nobody watching (no card was raised), or the turn stopped. */
export type AskOutcome = { reply: AskReply } | { unattended: true } | { cancelled: true };

/** What answering an ask did. */
export type AskAnswerResult = 'answered' | 'unknown' | { invalid: string };
