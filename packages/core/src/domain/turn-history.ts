import { createHash } from 'node:crypto';
import type { ChatEngine, EngineEvent } from '../ports/chat-engine.js';
import type { Store } from '../ports/store.js';
import type { ToolSpec } from '../ports/tool-provider.js';
import type { ResolvedProfile } from '../types/config.js';
import { classifyProviderError } from '../types/errors.js';
import type { CanonMessage } from '../types/messages.js';
import { cutAtContextLine } from './context-lines.js';
import {
  DEFAULT_FOLD_TOKENS,
  HISTORY_SUMMARY_TARGET_CHARS,
  KEEP_SHARE,
  MAX_FOLD_CALLS,
  currentHistorySummary,
  estimateTokens,
  finaliseHistorySummary,
  historySummaryBlock,
  historySummaryPrompt,
  pickCut,
  summariseThreshold,
  summaryChunks,
  type HistorySummaryPart,
} from './history-summary.js';
import { recordUsage } from './usage-record.js';

/** How long one summarising call may take before the turn goes on without it. */
export const HISTORY_SUMMARY_TIMEOUT_MS = 120_000;

/** Finish reasons (AI SDK and Anthropic spellings) that mean the answer is incomplete or withheld: never kept as a summary. */
const TRUNCATING_FINISH_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens', 'model_context_window_exceeded', 'content-filter', 'refusal', 'error']);

/**
 * A hash of exactly what a summary covers: each message's id, role and the
 * parts a model is sent. A stored summary is used only while this still
 * matches the messages before its cut, so an edit, another branch or a message
 * changed in place can never be answered from a summary of something else.
 * Parts a model never reads (notices, links, cards) are left out, so a link
 * updated after the fact doesn't throw a good summary away.
 */
export function coveredHash(messages: readonly CanonMessage[]): string {
  const hash = createHash('sha256');
  for (const m of messages) {
    hash.update(JSON.stringify([m.id, m.role]));
    for (const p of m.parts) {
      if (p.type === 'text' || p.type === 'tool-call' || p.type === 'tool-result') hash.update(JSON.stringify(p));
      else if (p.type === 'user-note') hash.update(JSON.stringify([p.type, p.text, p.attachments.map((a) => a.attachmentId)]));
      else if (p.type === 'image' || p.type === 'file') hash.update(JSON.stringify([p.type, p.attachmentId]));
    }
  }
  return hash.digest('hex');
}

export interface HistoryViewInput {
  chatId: string;
  /** The reply being written: the summarising call's usage hangs off it. */
  messageId: string;
  userMessageId: string;
  /** The chat's profile as it is: the summarising call runs on it. */
  profile: ResolvedProfile;
  /** The same profile with the turn's system prompt, as the request carries it. */
  requestProfile: ResolvedProfile;
  /** The request's messages as they would go: the system message when there is one, then the conversation. */
  messages: CanonMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

/**
 * One turn's view of its history for a model API: the request as it would go,
 * the summary already made for this path (if any), and the two moments more
 * of it may be folded in (before sending, when the model's window is known,
 * and once after the provider refuses the request as too long).
 */
export class HistoryView {
  private readonly system: CanonMessage | null;
  /** The conversation as the request carries it, and as stored: the same messages in the same order. */
  private readonly convo: CanonMessage[];
  private summary: { text: string; uptoIndex: number } | null = null;
  private overflowTried = false;

  constructor(
    private readonly store: Store,
    private readonly engine: ChatEngine,
    private readonly now: () => number,
    private readonly generateId: () => string,
    private readonly input: HistoryViewInput,
    private readonly stored: CanonMessage[]
  ) {
    this.system = input.messages[0]?.role === 'system' ? input.messages[0] : null;
    this.convo = this.system ? input.messages.slice(1) : input.messages;
    // Only the profile's own summary: each profile cuts for its own model's window (a compare turn's variants too).
    const found = currentHistorySummary(stored, input.profile.id);
    if (found && found.part.covered === coveredHash(stored.slice(0, found.uptoIndex + 1))) {
      this.summary = { text: found.part.text, uptoIndex: found.uptoIndex };
    }
  }

  private get window(): number | null {
    const w = this.input.profile.model?.contextWindow;
    return typeof w === 'number' && w > 0 ? w : null;
  }

  /** The profile and messages to send: as given, or with the summary at the end of the system prompt and the messages it covers left out. */
  request(): { profile: ResolvedProfile; messages: CanonMessage[] } {
    const { requestProfile, messages } = this.input;
    if (!this.summary) return { profile: requestProfile, messages };
    const block = historySummaryBlock(this.summary.text);
    const systemPrompt = requestProfile.systemPrompt ? `${requestProfile.systemPrompt}\n\n${block}` : block;
    const system: CanonMessage = this.system
      ? { ...this.system, parts: [{ type: 'text', text: systemPrompt }] }
      : { id: `system:${requestProfile.id}`, chatId: this.input.chatId, parentId: null, role: 'system', parts: [{ type: 'text', text: systemPrompt }], status: 'complete', error: null, producedBy: null, createdAt: 0 };
    return { profile: { ...requestProfile, systemPrompt }, messages: [system, ...this.convo.slice(this.summary.uptoIndex + 1)] };
  }

  /**
   * What the request is likely to cost in tokens. The provider's own count
   * for the reply before this one, plus what has been added since, when that
   * reply was this profile's and its usage row says; else the estimate.
   */
  private size(): number {
    const { profile, chatId, tools } = this.input;
    const previous = this.stored.at(-2);
    const last = this.convo.at(-1);
    if (previous?.role === 'assistant' && previous.producedBy?.profileId === profile.id && previous.producedBy.modelId === profile.modelId && last) {
      const row = this.store.usage.list(chatId).find((u) => u.messageId === previous.id && !u.purpose && !u.subagentCallId && typeof u.contextTokens === 'number' && u.contextTokens > 0);
      if (row?.contextTokens) return row.contextTokens + row.tokensOut + estimateTokens([last]);
    }
    return estimateTokens(this.request().messages, tools);
  }

  /**
   * Before the request goes: with a known context window, folds the oldest
   * messages into the summary when the request is close to it. Returns the
   * part to store on the reply, or null when nothing changed (not close, the
   * window isn't known, nothing older to fold, or the summarising call failed).
   */
  async fitWindow(): Promise<HistorySummaryPart | null> {
    const window = this.window;
    if (window === null) return null;
    if (this.size() <= summariseThreshold(window, this.input.profile.params.maxOutputTokens)) return null;
    return this.fold(Math.floor(window * KEEP_SHARE));
  }

  /**
   * After the provider refused the request as too long (the window wasn't
   * known, or the estimate was wrong): folds until about half of what was
   * sent is kept. Once per turn, so a request that still doesn't fit fails as
   * it would have.
   */
  async afterOverflow(): Promise<HistorySummaryPart | null> {
    if (this.overflowTried) return null;
    this.overflowTried = true;
    const half = Math.floor(estimateTokens(this.request().messages, this.input.tools) / 2);
    const window = this.window;
    return this.fold(window === null ? half : Math.min(half, Math.floor(window * KEEP_SHARE)));
  }

  private async fold(keepTokens: number): Promise<HistorySummaryPart | null> {
    try {
      const start = this.summary ? this.summary.uptoIndex + 1 : 0;
      const cut = pickCut(this.convo.slice(start), keepTokens);
      if (cut === null) return null;
      const window = this.window;
      // A small model gets a shorter summary: a tenth of its window at most.
      const target = window === null ? HISTORY_SUMMARY_TARGET_CHARS : Math.max(1_000, Math.min(HISTORY_SUMMARY_TARGET_CHARS, Math.floor(window * 0.3)));
      const chunks = summaryChunks(this.convo.slice(start, start + cut), window === null ? DEFAULT_FOLD_TOKENS : Math.floor(window / 2));
      if (chunks.length === 0 || chunks.length > MAX_FOLD_CALLS) return null;
      let text = this.summary?.text ?? null;
      for (const chunk of chunks) {
        text = await this.ask(historySummaryPrompt(text, chunk, target), target);
        if (text === null) return null;
      }
      if (text === null) return null;
      const uptoIndex = start + cut - 1;
      this.summary = { text, uptoIndex };
      return { type: 'history-summary', uptoMessageId: this.stored[uptoIndex]!.id, covered: coveredHash(this.stored.slice(0, uptoIndex + 1)), text };
    } catch (err) {
      // Whatever went wrong, the turn goes on as it would have.
      console.warn(`[TurnRunner] could not summarise chat ${this.input.chatId}'s earlier messages:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * One tool-less utility call on the chat's own profile (it is sent this
   * conversation anyway, so nothing new leaves the machine). Null on any
   * failure: an error, a cut-off answer, an empty one, a stop or the timeout.
   */
  private async ask(prompt: string, target: number): Promise<string | null> {
    const { profile, chatId, messageId, signal } = this.input;
    if (signal.aborted) return null;
    const startedAt = this.now();
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, HISTORY_SUMMARY_TIMEOUT_MS);
    let text = '';
    try {
      const events: AsyncIterable<EngineEvent> = this.engine.stream({
        profile,
        messages: [{ id: `history-summary-prompt:${this.generateId()}`, chatId, parentId: null, role: 'user', parts: [{ type: 'text', text: prompt }], status: 'complete', error: null, producedBy: null, createdAt: startedAt }],
        tools: [],
        signal: controller.signal,
        chatId,
        messageId: `history-summary:${this.generateId()}`,
        workspaceRoot: null,
        purpose: 'utility',
      });
      for await (const event of events) {
        if (event.type === 'text-delta') text += event.text;
        else if (event.type === 'error') return null;
        else if (event.type === 'finish') {
          // Billed whatever becomes of the answer, so recorded first; a failed write never fails the call.
          try {
            recordUsage(this.store, { id: this.generateId(), chatId, messageId, profile, usage: event.usage, latencyMs: this.now() - startedAt, purpose: 'summary' });
          } catch (err) {
            console.warn(`[TurnRunner] could not record the summary call's usage for chat ${chatId}:`, err instanceof Error ? err.message : err);
          }
          if (TRUNCATING_FINISH_REASONS.has(event.finishReason)) return null;
          return controller.signal.aborted ? null : finaliseHistorySummary(text, target);
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      controller.abort();
    }
  }
}

/**
 * The turn's history view, or null when there is nothing to do for it: the
 * request's conversation isn't the stored path message for message (then
 * nothing is cut: a summary must cover exactly the messages it replaces).
 */
export function openHistoryView(store: Store, engine: ChatEngine, now: () => number, generateId: () => string, input: HistoryViewInput): HistoryView | null {
  const stored = cutAtContextLine(store.messages.pathToRoot(input.userMessageId));
  const convo = input.messages[0]?.role === 'system' ? input.messages.slice(1) : input.messages;
  if (stored.length !== convo.length || stored.some((m, i) => m.id !== convo[i]!.id)) return null;
  return new HistoryView(store, engine, now, generateId, input, stored);
}

/**
 * `first`, or, when it fails as too long for the model before anything else
 * has come out of it, the stream `again` gives (null: nothing more can be
 * done, and the failure goes on as it was). Nothing has run by then (an
 * engine reports a tool call before it runs it), so starting over repeats
 * nothing. `again` is asked once at most.
 */
export async function* retryOnOverflow(first: AsyncIterable<EngineEvent>, again: () => Promise<AsyncIterable<EngineEvent> | null>): AsyncIterable<EngineEvent> {
  let seen = false;
  try {
    for await (const event of first) {
      if (!seen && event.type === 'error' && event.error.kind === 'context_overflow') {
        // Marked first: whatever the second stream does, it is never started over.
        seen = true;
        const next = await again();
        if (next) {
          yield* next;
          return;
        }
      }
      seen = true;
      yield event;
    }
  } catch (err) {
    if (seen || classifyProviderError(err).kind !== 'context_overflow') throw err;
    const next = await again();
    if (!next) throw err;
    yield* next;
  }
}
