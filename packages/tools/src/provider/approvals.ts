/**
 * The approval round-trip of `OtherBenchToolProvider` (`../provider.ts`):
 * turning a `PermissionBroker.decide()` answer into an `Authorization`, and
 * for an 'ask', raising the card, waiting for a person (or the turn ending,
 * or the broker's backstop) and handing the answer to `broker.resolve()`
 * exactly once. Every card path comes through `settle` (gated tools, Claude
 * Code's gate, the sandbox's network ask), so an unattended run's refusal is
 * made here once for all of them.
 *
 * `resolveApproval` is the other half of that suspension: called by the HTTP
 * route (routes/tools.ts) when a human answers a prompt, it wakes the exact
 * `awaitApproval` promise for that `requestId` -- keyed by request id, never
 * by `messageId` or chat id, which is what makes concurrent compare-turn
 * variants independent (decision #2's explicit requirement): resolving one
 * variant's request touches only that request's waiter.
 */
import { COMPUTER_UNATTENDED_REASON, isUnattendedRun } from '@otherbench/core/domain/computer-apps.js';
import { auditGrantedBy, UNATTENDED_REASON, type Decision, type PermissionBroker } from '@otherbench/core/domain/permissions.js';
import type { ApprovalChoice, ApprovalRequest, ToolApprovalEvent, ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import { ANSWER_REFUSED_REASON, cancelledAuth, deniedAuth, DROPPED_REASON, messageOf, quoting, type Authorization, type SettleCause } from './outcomes.js';

export class ApprovalRoundTrip {
  private readonly listeners = new Set<(event: ToolApprovalEvent) => void>();
  /** requestId -> settle(choice, alreadyDroppedByBroker). One entry per card awaiting an answer; removed when it settles. */
  private readonly waiters = new Map<string, (choice: ApprovalChoice, cause: SettleCause, decidedOnNode?: string) => void>();

  constructor(private readonly broker: PermissionBroker) {
    // The broker's backstop dropped a request nobody ended. Its waiter must
    // not hang (or, worse, later be approved with the broker no longer
    // knowing it): settle it as a denial, which also emits `resolved` so the
    // UI drops the card.
    this.broker.onEvict((requestId) => this.waiters.get(requestId)?.({ choice: 'deny' }, 'dropped'));
  }

  onApprovalEvent(cb: (event: ToolApprovalEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Wakes the suspended gate for a still-pending approval request. Returns
   * `false` (a no-op) for an unknown/already-resolved id rather than
   * throwing -- a stale double-submit from the UI, or a request that timed
   * out via the turn being cancelled, must not crash the caller.
   */
  resolveApproval(requestId: string, choice: ApprovalChoice, decidedOnNode?: string): boolean {
    const settle = this.waiters.get(requestId);
    if (!settle) return false;
    settle(choice, 'user', decidedOnNode);
    return true;
  }

  /**
   * Turns a broker decision into an authorisation, raising (and waiting on) an approval card for 'ask'.
   * `tool` is the spec the call came in on: a denial of a computer call that may name something on the
   * machine is cleaned and labelled (`quoting`); one made because nobody is there is OtherBench's own sentence.
   */
  async settle(decision: Decision, ctx: ToolContext, tool: ToolSpec): Promise<Authorization> {
    if (decision.kind === 'deny') {
      // Plan mode's and a scheduled run's refusals are OtherBench's own sentences.
      if (decision.plan === true) return deniedAuth(decision.reason, false, true);
      const denied = deniedAuth(decision.reason, decision.unattended === true);
      return decision.unattended === true ? denied : quoting(tool, denied);
    }
    if (decision.kind === 'allow') return { ok: true, grantedBy: auditGrantedBy(decision) };

    const { request } = decision;
    // The turn already ended: nobody is there to answer and an abort listener
    // added now would never fire. Drop the request, raise no card.
    if (ctx.signal.aborted) {
      this.broker.discard(request.id);
      return cancelledAuth();
    }
    // A scheduled run (spec 2026-10-12-scheduled-tasks-design §2): nobody can
    // answer a card, so the request is dropped unanswered -- no waiter, no
    // event -- and the call is refused with a reason the model can act on.
    // Every card path comes through here (gated tools, Claude Code's gate,
    // the sandbox's network ask), so this one check covers them all. Computer
    // use never gets this far unattended (`described` and the broker refuse
    // it first, with its own reason); `isUnattendedRun` is its fail-closed
    // reading of the same one field, kept here too.
    if (ctx.unattended === true || (tool.source === 'computer' && isUnattendedRun(ctx))) {
      this.broker.discard(request.id);
      return {
        ok: false,
        code: 'approval_unavailable',
        reason: tool.source === 'computer' ? COMPUTER_UNATTENDED_REASON : UNATTENDED_REASON,
        grantedBy: 'deny:unattended',
      };
    }
    // Register the waiter BEFORE notifying so a listener that answers
    // synchronously from inside the 'request' event still reaches it.
    const pending = this.awaitApproval(request, ctx.signal);
    this.notify({ type: 'request', request });
    const { choice, cause, refusal, decidedOnNode } = await pending;
    this.notify({ type: 'resolved', requestId: request.id, messageId: request.messageId, choice: choice.choice });
    const on = decidedOnNode ? { decidedOnNode } : {};
    if (cause === 'turn-ended') return cancelledAuth();
    // The broker's reason names the program the card was about: not OtherBench's own words alone.
    if (cause === 'answer-refused') return { ...quoting(tool, deniedAuth(refusal ?? ANSWER_REFUSED_REASON, false)), ...on };
    if (cause === 'dropped') return { ok: false, code: 'approval_dropped', reason: DROPPED_REASON, grantedBy: 'deny:cancelled', ...on };
    if (choice.choice === 'deny') return { ok: false, code: 'approval_denied', reason: 'The user denied this tool call.', grantedBy: 'deny:user', ...on };
    return { ok: true, grantedBy: `ask:${choice.choice}`, ...on };
  }

  /** Sends one event to every listener; a listener that throws is logged and the rest still hear it. */
  notify(event: ToolApprovalEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error('[OtherBenchToolProvider] an approval listener threw:', err);
      }
    }
  }

  /**
   * Suspends until `resolveApproval(requestId, ...)` is called, or
   * `signal` aborts (the turn/variant was cancelled) -- whichever comes
   * first. `PermissionBroker.resolve()` is called EXACTLY once, from
   * `settle`, regardless of which path triggered it -- a `done` guard stops
   * a same-tick race between a real answer and an abort from calling it
   * twice (the broker throws on a duplicate resolve of the same request
   * id). An abort is treated as an implicit denial: 'deny' persists no
   * grant, so this is always safe to do without asking anyone.
   *
   * When the broker refuses the answer itself (it throws): for computer use
   * the call is DENIED (cause `answer-refused`, with the broker's reason).
   * Such an answer is a "for this chat" or "always" for an app that only
   * ever gets "allow once", or an "always" naming another app than the card
   * did; the card offers neither, so nothing a person was shown stands
   * behind it, and the call must not run on its strength. Every other source
   * keeps what it always did: the failure is logged and the call goes ahead
   * on the answer, with no grant stored, and as what it now is: once (the
   * audit row and the `resolved` event must not claim a grant that doesn't
   * exist).
   */
  private awaitApproval(
    request: ApprovalRequest,
    signal: AbortSignal
  ): Promise<{ choice: ApprovalChoice; cause: SettleCause; refusal?: string; decidedOnNode?: string }> {
    const requestId = request.id;
    return new Promise((resolve) => {
      let done = false;
      const settle = (choice: ApprovalChoice, cause: SettleCause, decidedOnNode?: string): void => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(requestId);
        let final = choice;
        let refusal: string | undefined;
        if (cause === 'dropped' || !this.broker.hasPending(requestId)) {
          // The broker no longer knows this request, so it can neither record
          // a grant nor vouch for the call. Fail closed.
          final = { choice: 'deny' };
        } else {
          try {
            this.broker.resolve(requestId, choice);
          } catch (err) {
            if (request.source === 'computer') {
              // The broker's message names the program: one clean line of it, in the log as in the refusal.
              console.error(`[OtherBenchToolProvider] broker.resolve("${requestId}") failed: ${messageOf(err)}`);
              final = { choice: 'deny' };
              refusal = `${ANSWER_REFUSED_REASON} ${messageOf(err)}`;
            } else {
              console.error(`[OtherBenchToolProvider] broker.resolve("${requestId}") failed:`, err);
              // The broker stored no grant (an "always" naming another host, a
              // shell answer with no command to pin, ...). The person did say
              // yes to this call, so it runs, but as what it now is: once.
              if (choice.choice !== 'deny') final = { choice: 'once' };
            }
          }
        }
        resolve({
          choice: final,
          cause: refusal !== undefined ? 'answer-refused' : cause === 'user' && final.choice === 'deny' && choice.choice !== 'deny' ? 'dropped' : cause,
          ...(refusal !== undefined ? { refusal } : {}),
          ...(decidedOnNode ? { decidedOnNode } : {}),
        });
      };
      const onAbort = (): void => settle({ choice: 'deny' }, 'turn-ended');
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(requestId, settle);
    });
  }
}
