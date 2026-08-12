import { randomUUID } from 'node:crypto';
import type { ChatEngine, EngineEvent, EngineRequest } from '../ports/chat-engine.js';
import type { Store } from '../ports/store.js';
import type { CanonMessage, MessageStatus, Part, SerializedError } from '../types/messages.js';
import type { ResolvedProfile } from '../types/config.js';
import type { PricingSnapshot, Usage } from '../types/usage.js';
import { estimateCost } from '../types/usage.js';
import { classifyProviderError } from '../types/errors.js';

/**
 * One event out of a turn's lifecycle, tagged with the message id it
 * belongs to. `messageId` is what lets a single subscriber (the SSE
 * transport, task 17) multiplex every variant of a compare turn over one
 * channel: the caller demuxes by `messageId`, not by which `run()` call
 * produced it.
 */
export type TurnEvent = { messageId: string } & (EngineEvent | { type: 'status'; status: MessageStatus });

export interface TurnInput {
  chatId: string;
  parentId: string | null;
  userParts: Part[];
  profiles: ResolvedProfile[];
}

export interface TurnResult {
  userMessageId: string;
  assistantMessageIds: string[];
}

export interface TurnRunnerOptions {
  /** Overridable clock, so the 500ms checkpoint throttle is testable without real delays. */
  now?: () => number;
  /** Overridable id generator; defaults to `randomUUID`. */
  generateId?: () => string;
  /** How often (ms) a streaming variant's partial parts may be re-checkpointed to the store. */
  checkpointIntervalMs?: number;
}

const DEFAULT_CHECKPOINT_INTERVAL_MS = 500;

/**
 * Appends streamed text (or reasoning) onto `parts`, merging into the
 * trailing part when it is already the same kind (the common case -- a
 * run of `text-delta` events building up one paragraph) rather than
 * fragmenting one logical span of text into one `Part` per network chunk.
 * A different kind arriving (e.g. a tool-call between two text spans, or
 * the very first delta) starts a new part instead.
 */
function appendDelta(parts: Part[], kind: 'text' | 'reasoning', text: string): Part[] {
  const last = parts.at(-1);
  if (last && last.type === kind) {
    const merged = { ...last, text: last.text + text } as Part;
    return [...parts.slice(0, -1), merged];
  }
  return [...parts, { type: kind, text } as Part];
}

/**
 * Runs the lifecycle of one user turn: persists the user message, fans it
 * out to one assistant message per profile (a "compare turn" when there is
 * more than one), and streams each variant from the `ChatEngine`
 * independently -- one variant erroring, being cancelled, or running slow
 * never affects its siblings, because each is its own `AbortController` and
 * its own unawaited async task. `run()` itself only awaits the synchronous
 * bookkeeping (creating the rows); the actual streaming continues in the
 * background and is observed via `on()`.
 */
export class TurnRunner {
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly checkpointIntervalMs: number;
  private readonly listeners = new Set<(e: TurnEvent) => void>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly engine: ChatEngine,
    options: TurnRunnerOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? randomUUID;
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
  }

  /** Subscribes to every `TurnEvent` this runner emits, across every turn/chat it drives. Returns an unsubscribe function. */
  on(cb: (e: TurnEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(event: TurnEvent): void {
    for (const cb of this.listeners) cb(event);
  }

  async run(input: TurnInput): Promise<TurnResult> {
    const userMessage = this.store.messages.create({
      id: this.generateId(),
      chatId: input.chatId,
      parentId: input.parentId,
      role: 'user',
      parts: input.userParts,
      status: 'complete',
      error: null,
      producedBy: null,
    });

    const variants: { message: CanonMessage; profile: ResolvedProfile }[] = [];
    for (const profile of input.profiles) {
      const assistantMessage = this.store.messages.create({
        id: this.generateId(),
        chatId: input.chatId,
        parentId: userMessage.id,
        role: 'assistant',
        parts: [],
        status: 'streaming',
        error: null,
        producedBy: {
          profileId: profile.id,
          profileName: profile.name,
          connectionId: profile.connectionId,
          modelId: profile.modelId,
        },
      });
      variants.push({ message: assistantMessage, profile });
    }

    // Fire-and-forget: `run()` returns as soon as the rows exist. Each
    // variant is its own independent async task from here on, so a
    // rejection or slow stream in one cannot block or fail the others --
    // `runVariant` itself never throws (it catches internally), but the
    // `.catch` here is a last-resort backstop against a bug in that catch
    // logic turning into an unhandled rejection.
    for (const { message, profile } of variants) {
      void this.runVariant(input.chatId, userMessage.id, message.id, profile).catch((err: unknown) => {
        console.error(`[TurnRunner] variant ${message.id} failed outside its own error handling:`, err);
      });
    }

    return {
      userMessageId: userMessage.id,
      assistantMessageIds: variants.map((v) => v.message.id),
    };
  }

  /** Aborts one variant's stream. A no-op if `messageId` isn't currently running (already finished, or unknown). */
  cancel(messageId: string): void {
    this.controllers.get(messageId)?.abort();
  }

  private async runVariant(
    chatId: string,
    userMessageId: string,
    messageId: string,
    profile: ResolvedProfile
  ): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(messageId, controller);
    const startedAt = this.now();

    let parts: Part[] = [];
    let lastCheckpointAt = this.now();
    let status: MessageStatus = 'complete';
    let error: SerializedError | null = null;
    let usage: Usage | null = null;

    const checkpoint = (force: boolean): void => {
      const nowTs = this.now();
      if (force || nowTs - lastCheckpointAt >= this.checkpointIntervalMs) {
        this.store.messages.updateParts(messageId, parts);
        lastCheckpointAt = nowTs;
      }
    };

    try {
      const history = this.buildRequestMessages(userMessageId, profile);
      const request: EngineRequest = {
        profile,
        messages: history,
        tools: [], // no ToolProvider wired yet -- tool policy enforcement is task 21.
        signal: controller.signal,
        chatId,
        messageId,
      };

      for await (const event of this.engine.stream(request)) {
        this.emit({ messageId, ...event });

        switch (event.type) {
          case 'text-delta':
            parts = appendDelta(parts, 'text', event.text);
            checkpoint(false);
            break;
          case 'reasoning-delta':
            parts = appendDelta(parts, 'reasoning', event.text);
            checkpoint(false);
            break;
          case 'tool-call':
            parts = [...parts, { type: 'tool-call', id: event.id, name: event.name, args: event.args }];
            checkpoint(true);
            break;
          case 'tool-result':
            parts = [
              ...parts,
              { type: 'tool-result', id: event.id, name: event.name, result: event.result, isError: event.isError },
            ];
            checkpoint(true);
            break;
          case 'finish':
            usage = event.usage;
            break;
          case 'error':
            status = event.error.kind === 'cancelled' ? 'cancelled' : 'error';
            error = event.error;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      status = 'error';
      error = classifyProviderError(err);
    } finally {
      this.controllers.delete(messageId);
    }

    // The engine can end a stream cleanly on abort (no `error` event at
    // all -- MockChatEngine and this package's own `FakeChatEngine` both
    // do this, mirroring `streamText`'s observed behaviour, see
    // task-14-15-report.md). If nothing else already classified the
    // outcome, an aborted signal means this was a cancellation.
    if (controller.signal.aborted && status === 'complete' && error === null) {
      status = 'cancelled';
    }

    checkpoint(true);
    this.store.messages.updateStatus(messageId, status, error);
    this.emit({ messageId, type: 'status', status });

    // Usage is recorded whenever the engine reported it, regardless of the
    // final status: a cancellation that happens to race a `finish` event
    // (or, in the ordinary case, a `complete` run) both keep whatever
    // usage the engine actually reported.
    if (usage) {
      this.writeUsage(chatId, messageId, profile, usage, this.now() - startedAt);
    }
  }

  /**
   * The conversation this variant sees: every ancestor of the user message
   * down to (and including) it, with the profile's system prompt prepended
   * as a synthetic (unpersisted) system message when set. `Store.messages`
   * has no notion of a system message row -- the system prompt lives on
   * `Profile`, not in the tree -- so this is assembled fresh per variant
   * rather than read back from the store.
   */
  private buildRequestMessages(userMessageId: string, profile: ResolvedProfile): CanonMessage[] {
    const history = this.store.messages.pathToRoot(userMessageId);
    if (!profile.systemPrompt) return history;

    const systemMessage: CanonMessage = {
      id: `system:${profile.id}`,
      chatId: history[0]?.chatId ?? '',
      parentId: null,
      role: 'system',
      parts: [{ type: 'text', text: profile.systemPrompt }],
      status: 'complete',
      error: null,
      producedBy: null,
      createdAt: 0,
    };
    return [systemMessage, ...history];
  }

  /** Re-reads the model row at finish time (not the possibly-stale `ResolvedProfile.model` captured when the request began) so pricing reflects whatever is current right now. */
  private writeUsage(
    chatId: string,
    messageId: string,
    profile: ResolvedProfile,
    usage: Usage,
    latencyMs: number
  ): void {
    const currentModel = profile.model ? this.store.models.get(profile.model.id) : null;
    const pricingSnapshot: PricingSnapshot = currentModel
      ? {
          priceInPer1m: currentModel.priceInPer1m,
          priceOutPer1m: currentModel.priceOutPer1m,
          priceCachedPer1m: currentModel.priceCachedPer1m,
          currency: currentModel.currency,
        }
      : { priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' };

    this.store.usage.create({
      id: this.generateId(),
      chatId,
      messageId,
      profileId: profile.id,
      connectionId: profile.connectionId,
      modelId: profile.modelId,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      tokensCached: usage.tokensCached,
      tokensReasoning: usage.tokensReasoning,
      costEstimate: estimateCost(usage, pricingSnapshot),
      pricingSnapshot,
      latencyMs,
    });
  }
}
