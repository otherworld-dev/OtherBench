import { randomUUID } from 'node:crypto';
import type {
  ChatEngine,
  ConnectionTestResult,
  DiscoveredModel,
  EngineEvent,
  EngineRequest,
} from '@grunt/core/ports/chat-engine.js';
import type { ToolContext } from '@grunt/core/ports/tool-provider.js';
import type { Connection } from '@grunt/core/types/config.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import type { Usage } from '@grunt/core/types/usage.js';

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
  'Here is a mock reply from Grunt, streamed in small chunks so tokens arrive live ' +
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
 * order): `#fail` -> a single `rate_limit` error event. `#artifact` -> an
 * `artifact` create through the real tool when offered (Deck #896), then
 * "I made the artifact.". `#recall <query>` -> a `recall` search for the
 * rest of that line through the real tool when offered, then the titles of
 * the chats it found. `#browser <url>` -> a `browser` `open` of that address
 * through the real tool when offered, then the page's first heading.
 * `#computer` -> a screenshot, a click at (10, 20) and a short `type` through
 * the real `computer` tool when offered, then a slow reply (20 chunks a
 * second apart) that Stop can cancel; a step that fails ends it with a short
 * reply saying why. `#tool` -> a
 * simulated `read_file` tool call/result round trip, then a short answer
 * that quotes the (fabricated) file contents. `#slow` -> 20 chunks at
 * 400ms each. `#long` -> ~2000 tokens of lorem ipsum, for scroll/perf
 * testing. `#echo-system` -> the request's system prompt text (or "No system
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

    if (prompt.includes('#artifact')) {
      yield* this.streamArtifactTurn(req, tokensIn);
      return;
    }

    const recall = /#recall[ \t]+([^\r\n]*)/.exec(prompt);
    if (recall) {
      yield* this.streamRecallTurn(req, recall[1]!.trim(), tokensIn);
      return;
    }

    const browse = /#browser[ \t]+(\S+)/.exec(prompt);
    if (browse) {
      yield* this.streamBrowserTurn(req, browse[1]!, tokensIn);
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
    const ctx: ToolContext = { chatId: req.chatId, messageId: req.messageId, profileId: req.profile.id, workspaceRoot: req.workspaceRoot, signal: req.signal };
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

  /** `#recall <query>` (spec 2026-10-09-recall-design): one `recall` search through the real tool when offered, then the titles it found. */
  private async *streamRecallTurn(req: EngineRequest, query: string, tokensIn: number): AsyncGenerator<EngineEvent> {
    const callId = `mock-recall-${randomUUID()}`;
    const args = { command: 'search', query };
    if (req.signal.aborted) return;
    yield { type: 'tool-call', id: callId, name: 'recall', args };
    const tool = req.tools.find((t) => t.name === 'recall');
    const ctx: ToolContext = { chatId: req.chatId, messageId: req.messageId, profileId: req.profile.id, workspaceRoot: req.workspaceRoot, signal: req.signal };
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

  /** `#browser <url>` (spec 2026-10-12-model-browser-design §8): one `open` through the real tool when offered, then the page's first heading. */
  private async *streamBrowserTurn(req: EngineRequest, url: string, tokensIn: number): AsyncGenerator<EngineEvent> {
    const callId = `mock-browser-${randomUUID()}`;
    const args = { command: 'open', url };
    if (req.signal.aborted) return;
    yield { type: 'tool-call', id: callId, name: 'browser', args };
    const tool = req.tools.find((t) => t.name === 'browser');
    const ctx: ToolContext = { chatId: req.chatId, messageId: req.messageId, profileId: req.profile.id, workspaceRoot: req.workspaceRoot, signal: req.signal };
    const result = tool ? await tool.execute(args, ctx) : { error: true, code: 'unavailable', message: 'No browser tool was offered.' };
    if (req.signal.aborted) return;
    const isError = isToolErrorResult(result);
    yield { type: 'tool-result', id: callId, name: 'browser', result: JSON.stringify(result), isError };
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
    const ctx: ToolContext = { chatId: req.chatId, messageId: req.messageId, profileId: req.profile.id, workspaceRoot: req.workspaceRoot, signal: req.signal };
    for (const step of COMPUTER_STEPS) {
      if (req.signal.aborted) return;
      const args = structuredClone(step);
      const callId = `mock-computer-${randomUUID()}`;
      yield { type: 'tool-call', id: callId, name: 'computer', args };
      const result = tool ? await tool.execute(args, ctx) : { error: true, code: 'unavailable', message: 'No computer tool was offered.' };
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
   * supplied one via `req.tools` (task 26: `GruntToolProvider`'s gated
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
      const ctx: ToolContext = {
        chatId: req.chatId,
        messageId: req.messageId,
        profileId: req.profile.id,
        workspaceRoot: req.workspaceRoot,
        ...(req.folders && req.folders.length > 0 ? { folders: req.folders } : {}),
        signal: req.signal,
      };
      const result = await realTool.execute(args, ctx);
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
        displayName: 'Grunt Mock Model',
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
