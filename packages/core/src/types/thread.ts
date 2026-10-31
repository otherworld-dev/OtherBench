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
  | { kind: 'plan'; toolName: string; plan: string }
  /**
   * A media tool's prompt, shown to edit or cancel before anything reaches the backend. `negativePrompt` is
   * the one that will be sent (`''` for none), or null when the backend takes none. `settings` is one line
   * naming only what is applied, e.g. "1024×1024 · seed 42 · SDXL (ComfyUI)".
   */
  | { kind: 'generation'; toolName: string; media: 'image' | 'video'; prompt: string; negativePrompt: string | null; settings: string }
  /**
   * The model's browser needs a person: an "are you human" check, a sign-in. `site` is the page's committed site,
   * `reason` the model's words, cleaned. `window` says a real window is open for it; without one there is the panel.
   */
  | { kind: 'browser'; toolName: string; site: string; reason: string; window: boolean };

/** An ask waiting in the thread, tied to the reply that raised it. */
export type UserAsk = AskInput & { id: string; chatId: string; messageId: string };

/** The user's answer: one answer per question (multi-select joined with ", "), a skip or cancel, an approval, changes, or the prompt to generate. */
export type AskReply =
  | { answers: string[] }
  | { declined: true }
  | { approve: true }
  | { changes: string }
  | { generate: { prompt: string; negativePrompt: string | null } };

/** How an ask ended: answered, nobody watching (no card was raised), or the turn stopped. */
export type AskOutcome = { reply: AskReply } | { unattended: true } | { cancelled: true };

/** What answering an ask did. */
export type AskAnswerResult = 'answered' | 'unknown' | { invalid: string };
