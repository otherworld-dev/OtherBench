import { randomUUID } from 'node:crypto';
import type {
  ChatEngine,
  ConnectionTestResult,
  DiscoveredModel,
  EngineEvent,
  EngineRequest,
} from '@otherbench/core/ports/chat-engine.js';
import { SUBAGENT_TOOL_NAME } from '@otherbench/core/domain/parts.js';
import { toolContextFor } from '@otherbench/core/domain/tool-context.js';
import { ASK_TOOL, PLAN_APPROVED, PLAN_TOOL, TODO_TOOL, UNATTENDED_PLAN, STOPPED_ASK, type TodoItem } from '@otherbench/core/domain/thread-tools.js';
import type { Connection } from '@otherbench/core/types/config.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import type { Usage } from '@otherbench/core/types/usage.js';

/** Sleeps `ms` milliseconds, resolving early (never rejecting) if `signal` aborts first. */
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

export interface MockChatEngineOptions {
  /**
   * Overridable so tests don't have to wait out real chunk delays; defaults
   * to a real `setTimeout`-based sleep for actual manual/UI testing.
   */
  sleep?: SleepFn;
}

const realSleep: SleepFn = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

// Exactly 32 words -- "roughly 30 tokens" under the word-count-as-token
// estimate this mock uses (see `estimateTokens`).
const DEFAULT_REPLY =
  'Here is a mock reply from OtherBench, streamed in small chunks so tokens arrive live ' +
  'in the chat pane, complete with a bit of **markdown** and a `code span` for good measure.';

// Exactly 20 words, so splitting into 20 chunks yields one word per chunk --
// the brief calls for "20 chunks at 400ms" specifically for this trigger.
const SLOW_REPLY =
  'This reply trickles out slowly one word at a time so watch streaming indicator animate smoothly across chat pane now';

/**
 * `#computer`'s steps, in order. The screenshot comes first: the tool refuses
 * an action with a coordinate until the chat has taken one. The typed text is
 * plain words an end-to-end test can look for anywhere on the page (it must
 * only be in the approval card's typed-text box).
 */
const COMPUTER_STEPS: readonly Record<string, unknown>[] = [
  { action: 'screenshot' },
  { action: 'left_click', coordinate: [10, 20] },
  { action: 'type', text: 'hello from the mock' },
];

// Exactly 20 words, so 20 chunks a second apart: about 20 s for Stop to land in.
const COMPUTER_REPLY = 'I clicked and typed in the fake app, and now I will keep talking slowly, one word at a time.';

const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do',
  'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim',
];

/** Exactly 2000 words, for scroll/perf testing of very long assistant replies. */
function buildLongReply(): string {
  const words: string[] = [];
  for (let i = 0; i < 2000; i++) {
    words.push(LOREM_WORDS[i % LOREM_WORDS.length] as string);
  }
  return words.join(' ');
}
const LONG_REPLY = buildLongReply();

/** `#office <kind>` (spec 2026-10-12-office-files §6): one small sample of each Office kind, valid as the artifact tool checks it. */
export const OFFICE_SAMPLES: Record<string, { id: string; title: string; content: string }> = {
  document: {
    id: 'memo',
    title: 'Mock memo',
    content: '# Quarterly memo\n\nSales are **up** this quarter.\n\n| Item | Cost |\n| --- | ---: |\n| Widgets | 12 |\n| Gadgets | 30.5 |\n',
  },
  spreadsheet: {
    id: 'budget',
    title: 'Mock budget',
    content: JSON.stringify({
      sheets: [
        {
          name: 'Budget',
          columns: [{ width: 20 }, { width: 12 }],
          freeze: { rows: 1 },
          rows: [[{ value: 'Items', bold: true }, { value: 'Cost', bold: true }], ['Widgets', 12], ['Gadgets', 30.5], ['Total', '=SUM(B2:B3)']],
        },
      ],
    }),
  },
  presentation: {
    id: 'deck',
    title: 'Mock deck',
    content: JSON.stringify({
      slides: [
        { layout: 'title', title: 'Mock review', subtitle: 'From the mock model' },
        { layout: 'bullets', title: 'Highlights', bullets: ['Revenue up', 'Two new clients'], notes: 'Mention churn.' },
      ],
    }),
  },
};

/** The Mock's live page (spec 2026-10-12-live-artifacts): asks for key "b", shows what came back or why not, records CSP violations, and can leave. */
const LIVE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Live dashboard</title>
<script src="otherbench-live.js"></script>
<p>Value: <span id="out">waiting</span> · n: <span id="n">-</span></p>
<p>Blocked: <span id="csp"></span></p>
<button id="leave" type="button">Leave</button>
<script>
document.addEventListener('securitypolicyviolation', function (e) { document.getElementById('csp').textContent += e.effectiveDirective + ' '; });
document.getElementById('leave').addEventListener('click', function () { location.href = 'about:blank'; });
fetch('https://example.invalid/').catch(function () {});
otherbench.live('value', { key: 'b' }).then(
  function (r) { document.getElementById('out').textContent = r.json.value; document.getElementById('n').textContent = String(r.json.n); },
  function (e) { document.getElementById('out').textContent = 'error: ' + e.code; }
);
</script>`;

/** `#lists`: a Markdown reply with its line breaks, which the word-chunked replies lose, for checking how lists render (e2e). */
export const LISTS_REPLY = [
  'Steps:',
  '',
  '1. First step',
  '2. Second step',
  '',
  'Things:',
  '',
  '- Apples',
  '  - Green ones',
  '- Pears',
  '',
  'Carry on from:',
  '',
  '3. Third step',
  '4. Fourth step',
  '',
  '- [ ] A task to do',
  '- [x] A task done',
  '',
].join('\n');

/** Crude word-count-as-token-count proxy -- good enough for a mock's "plausible usage". */
function estimateTokens(text: string): number {
  return Math.max(1, text.split(/\s+/).filter(Boolean).length);
}

/**
 * Splits `text` into up to `chunkCount` pieces along word boundaries, in
 * order, such that concatenating them back together reproduces `text`
 * (modulo whitespace being normalised to single spaces). Yields fewer than
 * `chunkCount` pieces if there aren't enough words to fill them.
 */
function splitIntoChunks(text: string, chunkCount: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const count = Math.max(1, Math.min(chunkCount, words.length));
  const perChunk = Math.ceil(words.length / count);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += perChunk) {
    const group = words.slice(i, i + perChunk).join(' ');
    chunks.push(chunks.length === 0 ? group : ` ${group}`);
  }
  return chunks;
}

function isTextPart(part: Part): part is Extract<Part, { type: 'text' }> {
  return part.type === 'text';
}

/** The latest user message's text, which is what steers this mock's behaviour. */
function extractPromptText(messages: CanonMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    return message.parts.filter(isTextPart).map((p) => p.text).join('\n');
  }
  return '';
}

/** Rough input-token estimate across every text part in the whole conversation. */
function estimateInputTokens(messages: CanonMessage[]): number {
  const allText = messages
    .flatMap((m) => m.parts)
    .filter(isTextPart)
    .map((p) => p.text)
    .join(' ');
  return estimateTokens(allText);
}

function extractToolArgPath(prompt: string): string {
  const match = /#tool\s+(\S+)/.exec(prompt);
  return match?.[1] ?? 'example.txt';
}

/** Recognises the `{error: true, code, message}` shape every real `ToolSpec.execute()` in this codebase resolves with on failure (fs-tools.ts, shell-tool.ts, provider.ts) -- never a thrown exception, see those modules' own docs for why. */
function isToolErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { error?: unknown }).error === true;
}

/**
 * The first named heading in an accessibility snapshot. A line is `- heading "Title" [level=1] [ref=e1]`, and Playwright
 * wraps the whole key in YAML single quotes (apostrophes doubled) when it holds something YAML would misread, e.g.
 * `- 'heading "Q: why?" [level=2] [ref=e8]'`. The name inside is JSON-quoted. Only a line that starts with the heading
 * counts, so page text that merely says `heading "x"` is never taken for one. Local to the mock on purpose.
 */
function firstHeading(snapshot: string): string | null {
  for (const line of snapshot.split('\n')) {
    let key = line.trim().replace(/^- /, '');
    if (key.startsWith("'")) {
      const quoted = /^'((?:[^']|'')*)'(?=\s*(?::|$))/.exec(key);
      if (!quoted) continue;
      key = quoted[1]!.replace(/''/g, "'");
    }
    const name = /^heading\s+("(?:[^"\\]|\\.)*")/.exec(key);
    if (!name) continue;
    try {
      const text: unknown = JSON.parse(name[1]!);
      if (typeof text === 'string' && text.trim() !== '') return text;
    } catch {
      // not valid JSON: not a name we can read, try the next line
    }
  }
  return null;
}

/**
 * A keyless `ChatEngine` whose behaviour is driven entirely by markers in
 * the latest user message's text, so it can be steered by hand to exercise
 * the whole app -- streaming, tool calls, slow connections, long replies,
 * error handling -- with no API key and zero cost. Selected via
 * `ConnectionKind` `'mock'`.
 *
 * Triggers (checked against the prompt text, first match wins, in this
 * order): `#fail` -> a single `rate_limit` error event. `#subagents <rest>` ->
 * two `subagent` calls at once through the real tool when offered, then
 * "Sub-agents answered: 1) ... 2) ...". `#office
 * <document|spreadsheet|presentation>` -> that Office artifact made through the real tool,
 * then "I made the file.". `#echo-user` -> the latest user message's text
 * parts as the request carries them (an attached file's text included).
 * `#todos` -> three `update_todos` calls through the real tool when offered (a two-step
 * checklist, 1.5 s apart), then "All done.". `#ask` -> one `ask_user` question
 * ("Which colour?") through the real tool, then the answer back. `#plan` -> a
 * `write_file` that plan mode refuses, then `propose_plan` rounds until
 * approved, then the write again. `#live-artifact <tool>` -> a live html
 * artifact `dash` whose one call reads `<tool>` (spec 2026-10-12-live-artifacts),
 * checked before `#artifact`. `#artifact` -> an
 * `artifact` create through the real tool when offered (Deck #896), then
 * "I made the artifact.". `#recall <query>` -> a `recall` search for the
 * rest of that line through the real tool when offered, then the titles of
 * the chats it found. `#run <command>` -> a `run_command` call with the
 * rest of that line through the real tool when offered, then its output
 * ("I ran it in the sandbox: ..." for a sandboxed one). `#browser <url>` ->
 * a `browser` `open` of that address through the real tool when offered,
 * then the page's first heading; with ` handover` after the address, a
 * `handover` call before that. `#image <prompt>` / `#video <prompt>` -> a
 * `generate_image` / `generate_video` call with the rest of that line through
 * the real tool when offered, then "Done.".
 * `#computer` -> a screenshot, a click at (10, 20) and a short `type` through
 * the real `computer` tool when offered, then a slow reply (20 chunks a
 * second apart) that Stop can cancel; a step that fails ends it with a short
 * reply saying why. `#tool` -> a
 * simulated `read_file` tool call/result round trip, then a short answer
 * that quotes the (fabricated) file contents. `#slow` -> 20 chunks at
 * 400ms each. `#long` -> ~2000 tokens of lorem ipsum, for scroll/perf
 * testing. `#lists` -> a Markdown reply of numbered, bulleted and task lists, line breaks kept. `#echo-system` -> the request's system prompt text (or "No system
 * prompt."), so an end-to-end test can check what a turn sent, e.g. project
 * memory. Anything else -> a canned ~30-token markdown reply.
 *
 * Every branch reports a `finish` event with a plausible (word-count-based)
 * `Usage`; this mock has no real pricing, so callers should treat its
 * connection/model as priced at zero.
 */
export class MockChatEngine implements ChatEngine {
  private readonly sleep: SleepFn;

  constructor(options: MockChatEngineOptions = {}) {
    this.sleep = options.sleep ?? realSleep;
  }

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    if (req.signal.aborted) return;

    const prompt = extractPromptText(req.messages);
    const tokensIn = estimateInputTokens(req.messages);

    if (prompt.includes('#fail')) {
      yield {
        type: 'error',
        error: {
          kind: 'rate_limit',
          message: 'Mock provider: simulated rate limit (triggered by "#fail" in the prompt).',
          retryable: true,
        },
      };
      return;
    }

    const subagents = /#subagents(?:[ \t]+([^\r\n]*))?/.exec(prompt);
    if (subagents) {
      yield* this.streamSubagentsTurn(req, (subagents[1] ?? '').trim(), tokensIn);
      return;
    }

    const office = /#office[ \t]+([a-z-]+)/.exec(prompt);
    const sample = office && Object.hasOwn(OFFICE_SAMPLES, office[1]!) ? OFFICE_SAMPLES[office[1]!] : undefined;
    if (office && sample) {
      yield* this.streamOfficeTurn(req, office[1]!, sample, tokensIn);
      return;
    }

    if (prompt.includes('#echo-user')) {
      yield* this.streamReply(req, prompt, 8, 20, tokensIn);
      return;
    }

    if (prompt.includes('#todos')) {
      yield* this.streamTodosTurn(req, tokensIn);
      return;
    }

    if (prompt.includes('#ask')) {
      yield* this.streamAskTurn(req, tokensIn);
      return;
    }

    if (prompt.includes('#plan')) {
      yield* this.streamPlanTurn(req, tokensIn);
      return;
    }

    const live = /#live-artifact[ \t]+(\S+)/.exec(prompt);
    if (live) {
      yield* this.streamLiveArtifactTurn(req, live[1]!, tokensIn);
      return;
    }

    if (prompt.includes('#artifact')) {
      yield* this.streamArtifactTurn(req, tokensIn);
      return;
    }

    const recall = /#recall[ \t]+([^\r\n]*)/.exec(prompt);
    if (recall) {
      yield* this.streamRecallTurn(req, recall[1]!.trim(), tokensIn);
      return;
    }

    const run = /#run[ \t]+([^\r\n]+)/.exec(prompt);
    if (run) {
      yield* this.streamRunTurn(req, run[1]!.trim(), tokensIn);
      return;
    }

    const browse = /#browser[ \t]+(\S+)([ \t]+handover)?/.exec(prompt);
    if (browse) {
      yield* this.streamBrowserTurn(req, browse[1]!, browse[2] !== undefined, tokensIn);
      return;
    }

    const generate = /#(image|video)[ \t]+([^\r\n]+)/.exec(prompt);
    if (generate) {
      yield* this.streamMediaTurn(req, generate[1] === 'image' ? 'generate_image' : 'generate_video', generate[2]!.trim(), tokensIn);
      return;
    }

    if (prompt.includes('#computer')) {
      yield* this.streamComputerTurn(req, tokensIn);
      return;
    }

    if (prompt.includes('#tool')) {
      yield* this.streamToolTurn(req, prompt, tokensIn);
      return;
    }

    if (prompt.includes('#lists')) {
      for (const line of LISTS_REPLY.split(/(?<=\n)/)) {
        if (req.signal.aborted) return;
        await this.sleep(10, req.signal);
        yield { type: 'text-delta', text: line };
      }
      if (req.signal.aborted) return;
      yield finishEvent(tokensIn, estimateTokens(LISTS_REPLY));
      return;
    }

    if (prompt.includes('#slow')) {
      yield* this.streamReply(req, SLOW_REPLY, 20, 400, tokensIn);
      return;
    }

    if (prompt.includes('#long')) {
      yield* this.streamReply(req, LONG_REPLY, 40, 15, tokensIn);
      return;
    }

    if (prompt.includes('#echo-system')) {
      const system = req.messages
        .filter((m) => m.role === 'system')
        .flatMap((m) => m.parts)
        .filter(isTextPart)
        .map((p) => p.text)
        .join('\n');
      yield* this.streamReply(req, system.length > 0 ? system : 'No system prompt.', 8, 20, tokensIn);
      return;
    }

    yield* this.streamReply(req, DEFAULT_REPLY, 8, 50, tokensIn);
  }

  private async *streamReply(
    req: EngineRequest,
    text: string,
    chunkCount: number,
    delayMs: number,
    tokensIn: number
  ): AsyncGenerator<EngineEvent> {
    for (const chunk of splitIntoChunks(text, chunkCount)) {
      if (req.signal.aborted) return;
      await this.sleep(delayMs, req.signal);
      if (req.signal.aborted) return;
      yield { type: 'text-delta', text: chunk };
    }
    if (req.signal.aborted) return;
    yield finishEvent(tokensIn, estimateTokens(text));
  }

  /** `#artifact` (Deck #896): one `artifact` create through the real tool when offered, so the e2e drives the whole path. */
  private async *streamArtifactTurn(req: EngineRequest, tokensIn: number): AsyncGenerator<EngineEvent> {
    const callId = `mock-artifact-${randomUUID()}`;
    const args = { command: 'create', id: 'page', kind: 'html', title: 'Mock page', content: '<!doctype html><h1 id="h">Mock artifact</h1>' };
    if (req.signal.aborted) return;
    yield { type: 'tool-call', id: callId, name: 'artifact', args };
    const tool = req.tools.find((t) => t.name === 'artifact');
    const ctx = toolContextFor(req, req.signal, callId);
    const result = tool ? await tool.execute(args, ctx) : { error: true, code: 'unavailable', message: 'No artifact tool was offered.' };
    if (req.signal.aborted) return;
    const isError = isToolErrorResult(result);
    yield { type: 'tool-result', id: callId, name: 'artifact', result: JSON.stringify(result), isError };
    const answer = isError ? `The artifact didn't work: ${JSON.stringify(result)}` : 'I made the artifact.';
    for (const chunk of splitIntoChunks(answer, 6)) {
      if (req.signal.aborted) return;
      await this.sleep(30, req.signal);
      yield { type: 'text-delta', text: chunk };
    }
    yield finishEvent(tokensIn, estimateTokens(answer));
  }

  /** `#office <kind>`: one Office artifact made through the real tool when offered, so the e2e and the bundle smoke drive the whole path. */
  private async *streamOfficeTurn(req: EngineRequest, kind: string, sample: { id: string; title: string; content: string }, tokensIn: number): AsyncGenerator<EngineEvent> {
    const callId = `mock-office-${randomUUID()}`;
    const args = { command: 'create', id: sample.id, kind, title: sample.title, content: sample.content };
    if (req.signal.aborted) return;
    yield { type: 'tool-call', id: callId, name: 'artifact', args };
    const tool = req.tools.find((t) => t.name === 'artifact');
    const ctx = toolContextFor(req, req.signal, callId);
    const result = tool ? await tool.execute(args, ctx) : { error: true, code: 'unavailable', message: 'No artifact tool was offered.' };
    if (req.signal.aborted) return;
    const isError = isToolErrorResult(result);
    yield { type: 'tool-result', id: callId, name: 'artifact', result: JSON.stringify(result), isError };
    yield* this.answer(req, isError ? `The file didn't work: ${JSON.stringify(result)}` : 'I made the file.', tokensIn);
  }

  /** `#live-artifact <tool>` (spec 2026-10-12-live-artifacts): one live html artifact through the real tool, so the e2e drives the whole path. */
  private async *streamLiveArtifactTurn(req: EngineRequest, tool: string, tokensIn: number): AsyncGenerator<EngineEvent> {
    const callId = `mock-live-artifact-${randomUUID()}`;
    const declaration = { calls: [{ id: 'value', tool, args: { key: { $param: 'key' } }, params: { key: { enum: ['a', 'b'], default: 'a' } } }] };
    const args = { command: 'create', id: 'dash', kind: 'html', title: 'Live dashboard', content: LIVE_PAGE, live: JSON.stringify(declaration) };
    if (req.signal.aborted) return;
    yield { type: 'tool-call', id: callId, name: 'artifact', args };
    const artifact = req.tools.find((t) => t.name === 'artifact');
    const result = artifact ? await artifact.execute(args, toolContextFor(req)) : { error: true, code: 'unavailable', message: 'No artifact tool was offered.' };
    if (req.signal.aborted) return;
    const isError = isToolErrorResult(result);
    yield { type: 'tool-result', id: callId, name: 'artifact', result: JSON.stringify(result), isError };
    const answer = isError ? `The live artifact didn't work: ${JSON.stringify(result)}` : 'I made the live dashboard.';
    for (const chunk of splitIntoChunks(answer, 6)) {
      if (req.signal.aborted) return;
      await this.sleep(30, req.signal);
      yield { type: 'text-delta', text: chunk };
    }
    yield finishEvent(tokensIn, estimateTokens(answer));
  }

  /** One call to a tool from `req.tools` (the real, gated one), yielded as a call and its result; returns the result as text. */
  private async *callTool(req: EngineRequest, name: string, args: unknown): AsyncGenerator<EngineEvent, string | null> {
    const callId = `mock-${name}-${randomUUID()}`;
    if (req.signal.aborted) return null;
    yield { type: 'tool-call', id: callId, name, args };
    const tool = req.tools.find((t) => t.name === name);
    const result = tool ? await tool.execute(args, toolContextFor(req, req.signal, callId)) : { error: true, code: 'unavailable', message: `No ${name} tool was offered.` };
    if (req.signal.aborted) return null;
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    yield { type: 'tool-result', id: callId, name, result: text, isError: isToolErrorResult(result) };
    return text;
  }

  private async *answer(req: EngineRequest, text: string, tokensIn: number): AsyncGenerator<EngineEvent> {
    for (const chunk of splitIntoChunks(text, 6)) {
      if (req.signal.aborted) return;
      await this.sleep(30, req.signal);
      yield { type: 'text-delta', text: chunk };
    }
    if (req.signal.aborted) return;
    yield finishEvent(tokensIn, estimateTokens(text));
  }

  /** `#todos` (spec 2026-10-12-thread-cards-design §5): a two-step checklist updated three times, 1.5 s apart. */
  private async *streamTodosTurn(req: EngineRequest, tokensIn: number): AsyncGenerator<EngineEvent> {
    const step = (content: string, activeForm: string, status: TodoItem['status']): TodoItem => ({ content, activeForm, status });
    const lists: TodoItem[][] = [
      [step('Read the brief', 'Reading the brief', 'in_progress'), step('Write the answer', 'Writing the answer', 'pending')],
      [step('Read the brief', 'Reading the brief', 'completed'), step('Write the answer', 'Writing the answer', 'in_progress')],
      [step('Read the brief', 'Reading the brief', 'completed'), step('Write the answer', 'Writing the answer', 'completed')],
    ];
    for (const [i, todos] of lists.entries()) {
      if (i > 0) await this.sleep(1500, req.signal);
      if ((yield* this.callTool(req, TODO_TOOL, { todos })) === null) return;
    }
    yield* this.answer(req, 'All done.', tokensIn);
  }

  /** `#ask`: one question through the real ask_user tool, then the answer back. */
  private async *streamAskTurn(req: EngineRequest, tokensIn: number): AsyncGenerator<EngineEvent> {
    const args = {
      questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }], multiSelect: false }],
    };
    const result = yield* this.callTool(req, ASK_TOOL, args);
    if (result === null) return;
    yield* this.answer(req, `You said: ${result}`, tokensIn);
  }

  /**
   * `#plan`: a write that plan mode refuses, then up to three rounds of
   * propose_plan (revising after changes, stopping on approval, an unattended
   * answer or a stop), then the write again once approved.
   */
  private async *streamPlanTurn(req: EngineRequest, tokensIn: number): AsyncGenerator<EngineEvent> {
    const write = { path: 'planned.txt', content: 'planned' };
    const refused = yield* this.callTool(req, 'write_file', write);
    if (refused === null) return;
    let approved = false;
    for (let round = 1; round <= 3 && !approved; round++) {
      const result = yield* this.callTool(req, PLAN_TOOL, { plan: round === 1 ? '1. Write planned.txt' : '1. Write planned.txt (revised)' });
      if (result === null) return;
      if (result === PLAN_APPROVED) approved = true;
      else if (result === UNATTENDED_PLAN || result === STOPPED_ASK) break;
    }
    if (!approved) {
      yield* this.answer(req, `No plan was approved. The write said: ${refused}`, tokensIn);
      return;
    }
    const written = yield* this.callTool(req, 'write_file', write);
    if (written === null) return;
    yield* this.answer(req, `Done: ${written}`, tokensIn);
  }

  /**
   * `#subagents <rest of line>` (spec 2026-10-12-api-subagents-design): two
   * `subagent` calls in one go, run at once like a real step's, through the
   * real tool when offered. The first helper's prompt is the rest of the
   * line, so `#tool secrets.txt` in it makes that sub-agent (on the mock
   * connection too) call the real, gated `read_file`.
   */
  private async *streamSubagentsTurn(req: EngineRequest, rest: string, tokensIn: number): AsyncGenerator<EngineEvent> {
    const tool = req.tools.find((t) => t.name === SUBAGENT_TOOL_NAME);
    if (!tool) {
      yield* this.streamReply(req, 'No subagent tool was offered.', 4, 20, tokensIn);
      return;
    }
    const calls = [
      { id: `mock-subagent-${randomUUID()}`, args: { description: 'First helper', prompt: rest.length > 0 ? rest : 'Say hello.' } },
      { id: `mock-subagent-${randomUUID()}`, args: { description: 'Second helper', prompt: 'Say hello.' } },
    ];
    if (req.signal.aborted) return;
    for (const call of calls) yield { type: 'tool-call', id: call.id, name: SUBAGENT_TOOL_NAME, args: call.args };
    const results = await Promise.all(calls.map((call) => tool.execute(call.args, toolContextFor(req, req.signal, call.id))));
    if (req.signal.aborted) return;
    for (const [i, call] of calls.entries()) {
      const result = results[i];
      yield { type: 'tool-result', id: call.id, name: SUBAGENT_TOOL_NAME, result, isError: isToolErrorResult(result) };
    }
    const show = (r: unknown): string => (typeof r === 'string' ? r : JSON.stringify(r));
    const answer = `Sub-agents answered: 1) ${show(results[0])} 2) ${show(results[1])}`;
    for (const chunk of splitIntoChunks(answer, 8)) {
      if (req.signal.aborted) return;
      await this.sleep(30, req.signal);
      yield { type: 'text-delta', text: chunk };
    }
    if (req.signal.aborted) return;
    yield finishEvent(tokensIn, estimateTokens(answer));
  }

  /** `#recall <query>` (spec 2026-10-09-recall-design): one `recall` search through the real tool when offered, then the titles it found. */
  private async *streamRecallTurn(req: EngineRequest, query: string, tokensIn: number): AsyncGenerator<EngineEvent> {
    const callId = `mock-recall-${randomUUID()}`;
    const args = { command: 'search', query };
    if (req.signal.aborted) return;
    yield { type: 'tool-call', id: callId, name: 'recall', args };
    const tool = req.tools.find((t) => t.name === 'recall');
    const ctx = toolContextFor(req, req.signal, callId);
    const result = tool ? await tool.execute(args, ctx) : { error: true, code: 'unavailable', message: 'No recall tool was offered.' };
    if (req.signal.aborted) return;
    const isError = isToolErrorResult(result);
    yield { type: 'tool-result', id: callId, name: 'recall', result: JSON.stringify(result), isError };
    const titles = isError ? [] : ((result as { chats?: { title?: unknown }[] }).chats ?? []).map((c) => String(c.title));
    const answer = isError ? `Recall didn't work: ${JSON.stringify(result)}` : titles.length > 0 ? `I found: ${titles.join(', ')}.` : 'I found nothing.';
    for (const chunk of splitIntoChunks(answer, 6)) {
      if (req.signal.aborted) return;
      await this.sleep(30, req.signal);
      yield { type: 'text-delta', text: chunk };
    }
    yield finishEvent(tokensIn, estimateTokens(answer));
  }

  /** `#run <command>` (spec 2026-10-12-sandbox-design): one `run_command` call through the real tool when offered, then its output. */
  private async *streamRunTurn(req: EngineRequest, command: string, tokensIn: number): AsyncGenerator<EngineEvent> {
    const callId = `mock-run-${randomUUID()}`;
    const args = { command };
    if (req.signal.aborted) return;
    yield { type: 'tool-call', id: callId, name: 'run_command', args };
    const tool = req.tools.find((t) => t.name === 'run_command');
    // toolContextFor carries the reply's plan gate and the unattended flag, which the sandboxed shell must see too.
    const result = tool ? await tool.execute(args, toolContextFor(req)) : { error: true, code: 'unavailable', message: 'No run_command tool was offered.' };
    if (req.signal.aborted) return;
    const isError = isToolErrorResult(result);
    yield { type: 'tool-result', id: callId, name: 'run_command', result: JSON.stringify(result), isError };
    const r = result as { output?: unknown; sandbox?: unknown };
    const output = typeof r.output === 'string' ? r.output.trim() : '';
    const answer = isError ? `The command didn't run: ${JSON.stringify(result)}` : `I ran it${r.sandbox === true ? ' in the sandbox' : ''}: ${output}`;
    for (const chunk of splitIntoChunks(answer, 6)) {
      if (req.signal.aborted) return;
      await this.sleep(30, req.signal);
      yield { type: 'text-delta', text: chunk };
    }
    yield finishEvent(tokensIn, estimateTokens(answer));
  }

  /** `#browser <url>` (spec 2026-10-12-model-browser-design §8): one `open` through the real tool when offered, then the page's first heading. */
  private async *streamBrowserTurn(req: EngineRequest, url: string, handover: boolean, tokensIn: number): AsyncGenerator<EngineEvent> {
    const tool = req.tools.find((t) => t.name === 'browser');
    const calls: Record<string, unknown>[] = [{ command: 'open', url }, ...(handover ? [{ command: 'handover', reason: 'Please click the page to prove you are human.' }] : [])];
    let result: unknown;
    let isError = false;
    for (const args of calls) {
      const callId = `mock-browser-${randomUUID()}`;
      if (req.signal.aborted) return;
      yield { type: 'tool-call', id: callId, name: 'browser', args };
      // toolContextFor, like every other tool branch: the browser must see the reply's plan gate, the unattended flag and a sub-agent's tag.
      result = tool ? await tool.execute(args, toolContextFor(req, req.signal, callId)) : { error: true, code: 'unavailable', message: 'No browser tool was offered.' };
      if (req.signal.aborted) return;
      isError = isToolErrorResult(result);
      yield { type: 'tool-result', id: callId, name: 'browser', result: JSON.stringify(result), isError };
      if (isError) break;
    }
    const snapshot = (result as { snapshot?: unknown }).snapshot;
    const heading = !isError && typeof snapshot === 'string' ? firstHeading(snapshot) : null;
    const answer = isError
      ? `The browser didn't work: ${String((result as { message?: unknown }).message ?? JSON.stringify(result))}`
      : heading !== null
        ? `The page says: ${heading}.`
        : 'The page has no heading.';
    for (const chunk of splitIntoChunks(answer, 6)) {
      if (req.signal.aborted) return;
      await this.sleep(30, req.signal);
      yield { type: 'text-delta', text: chunk };
    }
    yield finishEvent(tokensIn, estimateTokens(answer));
  }

  /**
   * `#image <prompt>` / `#video <prompt>` (media-generation spec): one
   * generation through the real tool when offered, with the rest of the line
   * as its prompt. The result goes out as the tool returned it (the text and
   * the media), not as a JSON string, so `TurnRunner` keeps the media. Then
   * "Done.", or why it didn't work.
   */
  private async *streamMediaTurn(req: EngineRequest, name: string, prompt: string, tokensIn: number): AsyncGenerator<EngineEvent> {
    const callId = `mock-${name}-${randomUUID()}`;
    const args = { prompt };
    if (req.signal.aborted) return;
    yield { type: 'tool-call', id: callId, name, args };
    const tool = req.tools.find((t) => t.name === name);
    const result = tool ? await tool.execute(args, toolContextFor(req, req.signal, callId)) : { error: true, code: 'unavailable', message: `No ${name} tool was offered.` };
    if (req.signal.aborted) return;
    const isError = isToolErrorResult(result);
    yield { type: 'tool-result', id: callId, name, result, isError };
    yield* this.answer(req, isError ? `The generation didn't work: ${String((result as { message?: unknown }).message ?? JSON.stringify(result))}` : 'Done.', tokensIn);
  }

  /**
   * `#computer` (spec 2026-10-12-computer-use-design section 9): the steps in
   * `COMPUTER_STEPS` through the real tool when offered, so the e2e drives
   * the broker, the approval card and the fake driver. Each result goes out
   * as the tool returned it (an array with its images), not as a JSON string,
   * so `TurnRunner` keeps the images. The first step that fails (denied,
   * refused, no tool) ends the turn with a short reply saying why; otherwise
   * a slow reply follows that Stop can cancel.
   */
  private async *streamComputerTurn(req: EngineRequest, tokensIn: number): AsyncGenerator<EngineEvent> {
    const tool = req.tools.find((t) => t.name === 'computer');

    for (const step of COMPUTER_STEPS) {
      if (req.signal.aborted) return;
      const args = structuredClone(step);
      const callId = `mock-computer-${randomUUID()}`;
      yield { type: 'tool-call', id: callId, name: 'computer', args };
      // toolContextFor, like every other tool branch: computer use must see the reply's plan gate, the unattended flag and a sub-agent's tag.
      const result = tool ? await tool.execute(args, toolContextFor(req, req.signal, callId)) : { error: true, code: 'unavailable', message: 'No computer tool was offered.' };
      if (req.signal.aborted) return;
      const isError = isToolErrorResult(result);
      yield { type: 'tool-result', id: callId, name: 'computer', result, isError };
      if (isError) {
        const answer = `The computer didn't work: ${String((result as { message?: unknown }).message ?? JSON.stringify(result))}`;
        yield* this.streamReply(req, answer, 6, 30, tokensIn);
        return;
      }
    }
    yield* this.streamReply(req, COMPUTER_REPLY, 20, 1000, tokensIn);
  }

  /**
   * Routes `#tool` through a REAL `read_file` `ToolSpec` when the caller
   * supplied one via `req.tools` (task 26: `OtherBenchToolProvider`'s gated
   * output, threaded here exactly as `engine-aisdk`'s `buildToolSet` would
   * for a real model's tool call), rather than fabricating a result --
   * this is what lets the mock provider exercise the genuine approval flow
   * end to end in a real browser with no API key: `PermissionBroker.decide()`,
   * an `approval-request` event, a suspended wait (this generator simply
   * `await`s it, exactly mirroring how a real `streamText` step pauses on a
   * tool call), and a real (redacted, audited) result or a real denial --
   * not a scripted stand-in for any of that.
   *
   * Falls back to the original fabricated result when no matching tool was
   * supplied (`tools: []`, the default in most tests, including this
   * file's own `#tool` tests below) -- unchanged behaviour from before this
   * routing existed.
   */
  private async *streamToolTurn(req: EngineRequest, prompt: string, tokensIn: number): AsyncGenerator<EngineEvent> {
    const path = extractToolArgPath(prompt);
    const callId = `mock-tool-${randomUUID()}`;
    const args = { path };

    if (req.signal.aborted) return;
    await this.sleep(150, req.signal);
    if (req.signal.aborted) return;
    yield { type: 'tool-call', id: callId, name: 'read_file', args };

    const realTool = req.tools.find((t) => t.name === 'read_file');
    let resultText: string;
    let isError = false;

    if (realTool) {
      const result = await realTool.execute(args, toolContextFor(req, req.signal, callId));
      if (req.signal.aborted) return;
      isError = isToolErrorResult(result);
      resultText = typeof result === 'string' ? result : JSON.stringify(result);
    } else {
      resultText = `This is the mocked content of ${path}.`;
    }

    if (req.signal.aborted) return;
    await this.sleep(150, req.signal);
    if (req.signal.aborted) return;
    yield { type: 'tool-result', id: callId, name: 'read_file', result: resultText, isError };

    const answer = isError
      ? `I tried to read \`${path}\` but the call did not go through: ${resultText}`
      : `I read \`${path}\` and it contains: ${resultText}`;
    for (const chunk of splitIntoChunks(answer, 6)) {
      if (req.signal.aborted) return;
      await this.sleep(50, req.signal);
      if (req.signal.aborted) return;
      yield { type: 'text-delta', text: chunk };
    }

    if (req.signal.aborted) return;
    yield finishEvent(tokensIn, estimateTokens(answer));
  }

  async listModels(_conn: Connection, _apiKey: string | null): Promise<DiscoveredModel[]> {
    return [
      {
        modelId: 'mock-standard',
        displayName: 'OtherBench Mock Model',
        contextWindow: 128_000,
        supportsVision: true,
        supportsTools: true,
      },
    ];
  }

  async testConnection(_conn: Connection, _apiKey: string | null): Promise<ConnectionTestResult> {
    return {
      ok: true,
      message: 'Mock connection is always reachable; no network call is made.',
      latencyMs: 0,
    };
  }
}

function finishEvent(tokensIn: number, tokensOut: number): EngineEvent {
  const usage: Usage = { tokensIn, tokensOut, tokensCached: 0, tokensReasoning: 0 };
  return { type: 'finish', usage, finishReason: 'stop' };
}
