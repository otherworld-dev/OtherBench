import { randomUUID } from 'node:crypto';
import type { ToolApprovalEvent, ToolContext } from '../ports/tool-provider.js';
import type { AskAnswerResult, AskInput, AskOutcome, AskReply, UserAsk } from '../types/thread.js';
import { askReplyProblem } from './thread-tools.js';

/** At most this many asks wait at once; past it the oldest is settled as cancelled (a leak, logged). */
export const MAX_PENDING_ASKS = 50;

interface PendingAsk {
  ask: UserAsk;
  settle: (outcome: AskOutcome) => void;
}

/**
 * The questions and plans waiting for the user (spec
 * 2026-10-12-thread-cards-design §2), shared by `OtherBenchToolProvider` and
 * `FakeToolProvider`. Kept in memory like approval cards: a page reload
 * shows them again from the turn's buffered events, and a server restart
 * ends the turn anyway. Imports `node:crypto`, so the web never imports it.
 */
export class UserAsks {
  private readonly pending = new Map<string, PendingAsk>();

  constructor(
    private readonly notify: (event: ToolApprovalEvent) => void,
    private readonly generateId: () => string = randomUUID
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  ask(ctx: ToolContext, input: AskInput): Promise<AskOutcome> {
    // Nobody is watching: answered for the model, and no card, event or dot.
    if (ctx.unattended === true) return Promise.resolve({ unattended: true });
    if (ctx.signal.aborted) return Promise.resolve({ cancelled: true });
    this.makeRoom();
    const ask: UserAsk = { ...input, id: this.generateId(), chatId: ctx.chatId, messageId: ctx.messageId };
    // The waiter is registered before anyone hears of the ask, so a listener
    // that answers from inside the event still reaches it.
    const outcome = new Promise<AskOutcome>((resolve) => {
      let done = false;
      const settle = (result: AskOutcome): void => {
        if (done) return;
        done = true;
        ctx.signal.removeEventListener('abort', onAbort);
        this.pending.delete(ask.id);
        this.notify({ type: 'ask-resolved', askId: ask.id, messageId: ask.messageId });
        resolve(result);
      };
      const onAbort = (): void => settle({ cancelled: true });
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(ask.id, { ask, settle });
    });
    this.notify({ type: 'ask', ask });
    return outcome;
  }

  answer(askId: string, reply: AskReply): AskAnswerResult {
    const entry = this.pending.get(askId);
    if (!entry) return 'unknown';
    const problem = askReplyProblem(entry.ask, reply);
    if (problem !== null) return { invalid: problem };
    entry.settle({ reply });
    return 'answered';
  }

  private makeRoom(): void {
    while (this.pending.size >= MAX_PENDING_ASKS) {
      const oldest = this.pending.values().next().value as PendingAsk | undefined;
      if (!oldest) return;
      console.warn(`[UserAsks] ${MAX_PENDING_ASKS} asks are pending; settling the oldest ("${oldest.ask.id}") as cancelled.`);
      oldest.settle({ cancelled: true });
    }
  }
}
