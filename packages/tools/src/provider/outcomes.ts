/**
 * The words a gated call can end in, for `OtherBenchToolProvider`
 * (`../provider.ts`): an `Authorization` (approved, or `Denied` with a code,
 * a reason and how the audit names it), the provider's own fixed refusal
 * sentences, and the error result a refused call is answered with. What a
 * call may be refused for is the broker's to say (`PermissionBroker`,
 * core's `domain/permissions.ts`); this only says how the refusal reads.
 */
import { desktopTextForResult, screenContentError } from '@otherbench/core/domain/computer-apps.js';
import type { ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { ToolSource } from '@otherbench/core/types/config.js';

export interface ToolError {
  /** The line that says the message holds content from outside (today: `COMPUTER_SCREEN_ABOUT`), first when there. */
  about?: string;
  error: true;
  code: string;
  message: string;
}

export type Authorization = (
  | { ok: true; grantedBy: string }
  | {
      ok: false;
      code: 'permission_denied' | 'approval_denied' | 'cancelled' | 'approval_dropped' | 'plan_mode' | 'approval_unavailable' | 'no_approval';
      reason: string;
      grantedBy: 'deny:policy' | 'deny:user' | 'deny:cancelled' | 'deny:plan' | 'deny:unattended';
      /**
       * The line that says whose words `reason` may hold, when they may not
       * be OtherBench's own (`quoting`). The model reads it first, on every path.
       */
      about?: string;
    }
) & {
  /** The machine a person answered on, when it wasn't this one (v2 spec §3). */
  decidedOnNode?: string;
};

export type Denied = Extract<Authorization, { ok: false }>;

/**
 * Why a pending approval ended: a person answered it, its turn ended, the
 * broker's backstop dropped it, or the broker refused the answer itself
 * (computer use only: see `awaitApproval`).
 */
export type SettleCause = 'user' | 'turn-ended' | 'dropped' | 'answer-refused';

/**
 * A call that was refused before the broker decided. `unattended`: because
 * nobody is there to watch it. `plan`: because its reply's plan isn't
 * approved yet (Plan mode). `quoted`: the tool itself refused it while
 * describing it (or threw), so the reason may hold words that are not OtherBench's
 * (the computer tool passes on what the desktop app said, the browser quotes
 * the address it was sent).
 */
export interface Refused {
  refuse: string;
  unattended?: true;
  plan?: true;
  quoted?: true;
}

/**
 * What became of one call once every rule had its say (`decideCall`). `args`
 * is what the audit row is about: the described arguments when the call got
 * as far as being described, the model's own otherwise.
 */
export type CallDecision =
  /** Approved: `args` are the described arguments, the only ones that may run. */
  | { kind: 'approved'; args: unknown; grantedBy: string; decidedOnNode?: string }
  /** Not approved, for whatever reason (a rule, the person, a stop). Nothing runs. */
  | { kind: 'refused'; args: unknown; denied: Denied }
  /** Handed to Claude Code's own classifier (auto mode, `requestApproval` only). */
  | { kind: 'deferred'; args: unknown };

export const CANCELLED_REASON = 'The turn was stopped before this tool call was approved, so it did not run. Nobody denied it.';
export const STOPPED_BEFORE_RUN_REASON = 'The turn was stopped before this tool call ran, so it did not run. Nobody denied it.';
export const DROPPED_REASON = 'This approval request was dropped by the server (too many were pending), so the tool call did not run. Nobody denied it.';
export const ANSWER_REFUSED_REASON = "OtherBench couldn't accept that answer to the approval, so the tool call did not run and nothing was stored.";
export const UNCHECKED_REASON = "OtherBench couldn't check this call:";

export function cancelledAuth(reason: string = CANCELLED_REASON): Denied {
  return { ok: false, code: 'cancelled', reason, grantedBy: 'deny:cancelled' };
}

/** A refusal by the rules. One made because the run is unattended, or because the reply's plan waits, keeps its own name in the audit. */
export function deniedAuth(reason: string, unattended: boolean, plan = false): Denied {
  if (plan) return { ok: false, code: 'plan_mode', reason, grantedBy: 'deny:plan' };
  return unattended
    ? { ok: false, code: 'approval_unavailable', reason, grantedBy: 'deny:unattended' }
    : { ok: false, code: 'permission_denied', reason, grantedBy: 'deny:policy' };
}

export function toolError(code: string, message: string, about?: string): ToolError {
  return about === undefined ? { error: true, code, message } : { about, error: true, code, message };
}

/**
 * The tools whose calls are about a screen or a web page: what goes into
 * their approval, their audit row and their result can come from there, so
 * every string of theirs is cleaned on the way, and a throw anywhere in
 * deciding or running one ends the call instead of escaping.
 */
export function isScreenTool(source: ToolSource): source is 'browser' | 'computer' {
  return source === 'browser' || source === 'computer';
}

/** A message that isn't OtherBench's own (an error's, a tool's), as one clean bounded line. */
export function messageOf(err: unknown): string {
  return desktopTextForResult(err instanceof Error ? err.message : String(err)) || 'no reason was given';
}

/**
 * A refusal whose reason may hold words that are not OtherBench's own: what a tool
 * said while describing a call, what an error said, the broker naming a
 * program. For computer use it is rebuilt by core's one builder
 * (`screenContentError`): the reason as one clean line, and the line that
 * says it is content from the screen, which every path then puts first (the
 * API model's error result, Claude Code's denial). The provider's own fixed
 * sentences (computer use is off, nobody is there, the turn was stopped, the
 * request was dropped, the user denied it) never come through here: nothing
 * in them was written by anyone but OtherBench.
 */
export function quoting(tool: ToolSpec, denied: Denied): Denied {
  if (tool.source !== 'computer') return denied;
  const { about, message } = screenContentError(denied.code, denied.reason);
  return { ...denied, reason: message, about };
}

/** The error result a refused call is answered with. */
export function refusalResult(denied: Denied): ToolError {
  return toolError(denied.code, denied.reason, denied.about);
}
