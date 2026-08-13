import { randomUUID } from 'node:crypto';
import type { ChatEngine, EngineEvent, EngineRequest } from '../ports/chat-engine.js';
import type { Store } from '../ports/store.js';
import type { ApprovalChoice, ApprovalRequest, ToolProvider } from '../ports/tool-provider.js';
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
 * produced it. `approval-request`/`approval-resolved` (task 26) are relayed
 * here from a `ToolProvider`'s own `onApprovalEvent` -- see the constructor
 * subscription below -- rather than originating from `ChatEngine.stream()`,
 * since a gated tool's approval wait happens INSIDE a tool's `execute()`,
 * underneath the engine, not as a distinct stream event the engine itself
 * knows how to produce.
 */
export type TurnEvent = { messageId: string } & (
  | EngineEvent
  | { type: 'status'; status: MessageStatus }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'approval-resolved'; requestId: string; choice: ApprovalChoice['choice'] }
);

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
  /**
   * Supplies the tools a variant's `EngineRequest.tools` is populated with
   * (task 26). Omitted (the default) preserves the pre-task-26 behaviour of
   * every existing test and caller that constructs a `TurnRunner` without
   * one: `tools: []`, no approval events ever raised. When supplied,
   * `listTools(profile.toolPolicy)` is called once per variant (so a
   * profile's own policy -- not some global default -- governs what that
   * variant's model may call), and this runner subscribes to its
   * `onApprovalEvent` for the lifetime of the runner, relaying every event
   * as a `TurnEvent` tagged with the `messageId` the underlying
   * `ApprovalRequest` already carries (see the `ToolApprovalEvent` port
   * type's doc for why per-variant isolation falls out of that for free).
   */
  toolProvider?: ToolProvider;
}

const DEFAULT_CHECKPOINT_INTERVAL_MS = 500;

/**
 * Written for a variant cancelled before the engine ever reported usage --
 * see the comment at this file's only use site (the end of `runVariant`) for
 * why zero, rather than an estimate, is the honest answer here.
 */
const ZERO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 };

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
  private readonly toolProvider?: ToolProvider;
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
    this.toolProvider = options.toolProvider;
    this.toolProvider?.onApprovalEvent((event) => {
      if (event.type === 'request') {
        this.emit({ messageId: event.request.messageId, type: 'approval-request', request: event.request });
      } else {
        this.emit({ messageId: event.messageId, type: 'approval-resolved', requestId: event.requestId, choice: event.choice });
      }
    });
  }

  /** Subscribes to every `TurnEvent` this runner emits, across every turn/chat it drives. Returns an unsubscribe function. */
  on(cb: (e: TurnEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Each listener is invoked in its own try/catch: `emit()` is called from
   * inside `runVariant`'s own try block (see `run()`'s call site below), so
   * an uncaught throw from any one subscriber -- plausibly `controller.enqueue()`
   * in the SSE transport when a client disconnect races its unsubscribe --
   * would otherwise propagate out of `emit()`, be caught by `runVariant`'s
   * `catch`, and mis-persist that variant as a provider error via
   * `classifyProviderError`. A broadcast fault must never corrupt the
   * variant's own state, nor stop the remaining listeners from seeing the
   * event.
   */
  private emit(event: TurnEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error(`[TurnRunner] listener threw while handling '${event.type}' for message ${event.messageId}:`, err);
      }
    }
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

  /**
   * Re-runs one existing assistant message IN PLACE (same id, same
   * `parentId`) -- task 27's per-tab Retry on a failed compare variant.
   * Unlike `run()`, this never creates a new user message: the whole point
   * is that a retried variant stays the same sibling in its compare set,
   * not a duplicate turn hanging off a fresh (identical-text) user message.
   *
   * Resets the row's `parts`/`status`/`error` and emits a `status:
   * 'streaming'` event *synchronously*, before this function's first
   * `await` -- a caller (the turns route) that needs to reset a
   * `StreamRegistry` buffer for this message id can do so and then call
   * this, confident the reset lands before any new event does (same
   * ordering guarantee `registerTurn` relies on in `run()`, see
   * routes/turns.ts).
   *
   * Rejects if `messageId` is unknown, has no `parentId` to rebuild history
   * from (a retried message is always a reply, never a root), or is not
   * currently `'error'`. `'error'` is the only retryable status:
   *
   *   - `'streaming'` is already in flight -- retrying it makes no sense
   *     (cancel it first).
   *   - `'complete'` already holds a real answer with a real usage row; the
   *     defect this guard closes is exactly a retry silently discarding that
   *     content and writing a *second* usage row for the same logical
   *     variant, double-counting spend.
   *   - `'cancelled'` is deliberately excluded too, even though a user
   *     re-running a stream they themselves cancelled is a reasonable thing
   *     to want: a cancellation always writes a zeroed usage row (see
   *     `ZERO_USAGE` below) so the cancellation itself is never invisible to
   *     `usage.list()`. That row is keyed by this same `messageId`, and the
   *     usage rollup (`usage-rollup.ts`) attributes a usage row's bucket
   *     (measured vs. cancelled) from the *current* status of the message it
   *     points to, not from anything stored on the row itself. If retry
   *     reused this id and the message went on to complete, that old zeroed
   *     row would silently flip from "cancelled" into "measured" and inflate
   *     `completeCount` for a call that never happened -- not a cost error
   *     (the row is zero), but a phantom call. `'error'` doesn't have this
   *     problem: the ordinary error path (no `finish` ever raced the error)
   *     writes no usage row at all, so there is nothing stale left to
   *     misattribute. Re-running a cancelled turn is still possible -- it
   *     just goes through `run()` as a new turn, same as any other resend.
   */
  async retry(chatId: string, messageId: string, profile: ResolvedProfile): Promise<void> {
    const message = this.store.messages.get(messageId);
    if (!message) throw new Error(`retry: unknown message "${messageId}"`);
    if (!message.parentId) throw new Error(`retry: message "${messageId}" has no parent to rebuild history from`);
    if (message.status !== 'error') {
      throw new Error(`retry: message "${messageId}" is ${message.status}, not error -- only an errored message can be retried`);
    }

    this.store.messages.updateParts(messageId, []);
    this.store.messages.updateStatus(messageId, 'streaming'); // omitting `error` clears it -- see MessageRepo.updateStatus's doc.
    this.emit({ messageId, type: 'status', status: 'streaming' });

    await this.runVariant(chatId, message.parentId, messageId, profile);
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
      const workspaceRoot = this.store.chats.get(chatId)?.workspaceRoot ?? null;
      // Listed fresh per variant (not cached on the runner) so each variant's
      // request reflects THIS profile's own toolPolicy, and so a grant
      // revoked or an MCP server re-enabled between turns is picked up on
      // the very next call rather than requiring a restart -- ToolProvider
      // implementations are expected to keep their own MCP-connection state
      // long-lived internally; this call is just "what does this policy
      // currently allow", not "go reconnect everything".
      const tools = this.toolProvider ? await this.toolProvider.listTools(profile.toolPolicy) : [];
      const request: EngineRequest = {
        profile,
        messages: history,
        tools,
        signal: controller.signal,
        chatId,
        messageId,
        workspaceRoot,
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
    //
    // A cancellation that DIDN'T race a `finish` -- the common case, since
    // an abort ends the stream cleanly with no terminal event at all (see
    // the comment above) -- has no usage to keep: the `ChatEngine` port has
    // no incremental-usage event, only a terminal `finish { usage }`, so
    // there is genuinely no partial token count available here. Rather than
    // silently writing nothing (which made every cancellation invisible to
    // `usage.list()`/billing views), a zeroed usage row is written instead
    // so the cancellation is still recorded. The zeros are a known,
    // documented limitation of the current engine port -- not an estimate
    // of tokens actually consumed -- and should be revisited if `ChatEngine`
    // ever grows a way to report partial usage before completion.
    if (usage) {
      this.writeUsage(chatId, messageId, profile, usage, this.now() - startedAt);
    } else if (status === 'cancelled') {
      this.writeUsage(chatId, messageId, profile, ZERO_USAGE, this.now() - startedAt);
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
