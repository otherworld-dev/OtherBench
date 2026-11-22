/** What a starter is told when the chat it claimed is no longer its alone: something else started there meanwhile. */
export const CHAT_BUSY = 'A reply is being written in this chat.';

/** Thrown by `startTurn` when the claim it was given no longer holds the chat alone (`TurnGate.holdsAlone`). */
export class ChatBusyError extends Error {
  constructor(message: string = CHAT_BUSY) {
    super(message);
    this.name = 'ChatBusyError';
  }
}

/** A chat held for a turn that is being started. Released once its reply is running, or the start failed. */
export interface TurnClaim {
  readonly chatId: string;
  /** Ends the claim. Safe to call more than once. */
  release(): void;
}

interface Held extends TurnClaim {
  /** Out of the gate: released, or its chat was deleted. */
  gone: boolean;
}

/**
 * The one answer to "is this chat busy", and the one place a chat is taken for
 * a turn that is being started. A starter's own check used to be the running
 * replies (`events.runningTurns()`, which hears of a reply only once
 * `turn-started` is out) plus a private set of what that service alone was
 * starting, so a schedule, a chat-to-chat send and the notes service could
 * each find a chat free while another was still resolving its profile there.
 *
 * Two ways in, by what the starter does today when the chat is busy:
 *
 *  - `claim`: for a starter that must not start beside anything else (a
 *    schedule, a chat-to-chat send or resume, notes going out as a turn, a
 *    handover). Check and claim in one synchronous step: null when a reply is
 *    running or any start is held, and the caller skips, waits or queues as it
 *    always has. It keeps the claim across whatever it awaits and gives it to
 *    `startTurn`, which checks it is still alone (`holdsAlone`) in the same
 *    step that makes the rows.
 *  - `hold`: for a start that is never refused for being busy (a person's
 *    send, edit, regenerate or retry, which may run beside another reply as a
 *    compare retry does; a job turn; a reply Claude Code started by itself).
 *    It always gets one, so a claimer sees the chat taken from that moment
 *    rather than from `turn-started`.
 *
 * A compare turn is one start with several replies: one hold, whatever the
 * number of profiles.
 */
export class TurnGate {
  private readonly held = new Map<string, Set<Held>>();

  /** `running`: whether a reply is being written in the chat (`events.runningTurns()`). */
  constructor(private readonly running: (chatId: string) => boolean) {}

  /** A reply is being written in the chat, or a turn is being started there. */
  isBusy(chatId: string): boolean {
    return this.held.has(chatId) || this.running(chatId);
  }

  /** Takes a free chat for a turn about to be started; null when it is busy. No await sits between the check and the claim. */
  claim(chatId: string): TurnClaim | null {
    return this.isBusy(chatId) ? null : this.add(chatId);
  }

  /** Marks the chat as having a turn started in it, busy or not. */
  hold(chatId: string): TurnClaim {
    return this.add(chatId);
  }

  /** Whether `claim` is still in force with nothing else started or starting in its chat: what `claim` promised. */
  holdsAlone(claim: TurnClaim): boolean {
    const claims = this.held.get(claim.chatId);
    return claims !== undefined && claims.size === 1 && claims.has(claim as Held) && !this.running(claim.chatId);
  }

  /** The chat was deleted: whatever was held for it is let go. */
  forget(chatId: string): void {
    for (const claim of this.held.get(chatId) ?? []) claim.gone = true;
    this.held.delete(chatId);
  }

  private add(chatId: string): TurnClaim {
    const claims = this.held.get(chatId) ?? new Set<Held>();
    this.held.set(chatId, claims);
    const claim: Held = {
      chatId,
      gone: false,
      release: () => {
        if (claim.gone) return;
        claim.gone = true;
        claims.delete(claim);
        if (claims.size === 0) this.held.delete(chatId);
      },
    };
    claims.add(claim);
    return claim;
  }
}
