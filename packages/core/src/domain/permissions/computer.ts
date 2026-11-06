/**
 * Computer use's branch of the permission broker (`../permissions.ts`,
 * `source: 'computer'`): the refusals checked before any grant (a sub-agent,
 * an unattended run, an action or app OtherBench can't vouch for, OtherBench's
 * own UI, DevTools) and the looks that need no card. Its grants are pinned to
 * one app key (`grant-matching.ts`, `grant-minting.ts`); a high-risk app gets
 * cards only (`isHighRiskComputerCall`).
 */
import { cardLine } from '../card-text.js';
import {
  appKey,
  COMPUTER_BAD_ACTION_REASON,
  COMPUTER_DEVTOOLS_REASON,
  COMPUTER_OTHERBENCH_UI_REASON,
  COMPUTER_NO_APP_REASON,
  COMPUTER_NO_WINDOW_REASON,
  COMPUTER_UNATTENDED_REASON,
  expectationOf,
  isComputerAction,
  isDevToolsTitle,
  isHighRiskApp,
  isReadAction,
  isUnattendedRun,
  parseAction,
  showsOtherBenchUi,
} from '../computer-apps.js';
import type { ToolContext, ToolSpec } from '../../ports/tool-provider.js';
import type { Decision } from './decision.js';
import { rawField, stringField } from './fields.js';

/** A computer call made from inside a sub-agent. */
export const SUBAGENT_COMPUTER_REFUSAL = "A sub-agent can't use the computer. Say in your answer what needs doing on screen, and the reply that started you can do it.";

/**
 * What the broker does with a computer call before the grants and a card, or
 * null to carry on to them.
 */
export function computerDecision(args: unknown, ctx: ToolContext): Decision | null {
  // Computer use (spec 2026-10-12-computer-use-design §1). Never in a run
  // nobody is watching, whatever grants exist: checked before them.
  // Looking (screenshot, cursor position, wait) needs no card in either
  // mode -- the shell's own start dialog was the consent to see the screen
  // -- and goes by the action's NAME, never the declared risk. Anything
  // else needs a grant for the app the tool's describeCall resolved, or a
  // card; with no app at all it is refused (fail closed).

  // Never a sub-agent's, whatever policy it came with (its own policy has
  // computer use off: SUBAGENT_POLICY_RULES). Nobody watches a sub-agent's
  // screen, and its start would put the native dialog up for a job the
  // user never asked to watch. As for the thread and subagent tools.
  if (ctx.subagent) return { kind: 'deny', reason: SUBAGENT_COMPUTER_REFUSAL };
  // Fail closed: only a plain `false`, or nothing at all, says someone is
  // there. Any other value (a string, a number, null) counts as unattended.
  if (isUnattendedRun(ctx)) return { kind: 'deny', reason: COMPUTER_UNATTENDED_REASON, unattended: true };
  const action = stringField(args, 'action');
  // Exactly one of the known names, as a string: anything else (another
  // case, an array, a missing action) is refused, never treated as a look.
  if (!isComputerAction(action)) return { kind: 'deny', reason: `"${cardLine(action, 40)}" isn't a computer action OtherBench can do.` };
  // The whole action must be one OtherBench would carry out, within every cap
  // (`parseAction`): a readable coordinate, a key combination that stays
  // in the app, typed text with no control characters, a wait that is a
  // number. The tool's describeCall refuses these first, with a fuller
  // reason; this is the backstop, so neither a look nor a grant ever
  // covers one.
  // `reserved: []`: nothing to hold back here; the tool checked a key against the shell's real list.
  const valid = parseAction(args, { reserved: [] }).ok;
  if (isReadAction(action)) return valid ? { kind: 'allow', grantedBy: 'policy' } : { kind: 'deny', reason: COMPUTER_BAD_ACTION_REASON };
  // The app's key must be valid as it stands. One that isn't is no app.
  if (appKey(rawField(args, 'app')) === null) return { kind: 'deny', reason: COMPUTER_NO_APP_REASON };
  // A card and a grant are about one window of that app: without the
  // window, pid and start time the shell checks before acting, the call
  // could land anywhere, so it is refused.
  if (expectationOf(args) === null) return { kind: 'deny', reason: COMPUTER_NO_WINDOW_REASON };
  if (!valid) return { kind: 'deny', reason: COMPUTER_BAD_ACTION_REASON };
  // A window showing OtherBench's own UI (a browser tab of it) is refused before
  // any grant is looked at: `classifyTarget` refuses it first, and this is
  // the backstop, so no grant for the browser ever reaches OtherBench's cards.
  if (showsOtherBenchUi(rawField(args, 'appTitle'))) return { kind: 'deny', reason: COMPUTER_OTHERBENCH_UI_REASON };
  if (isDevToolsTitle(rawField(args, 'appTitle'))) return { kind: 'deny', reason: COMPUTER_DEVTOOLS_REASON };
  return null;
}

/** A computer-use call on a high-risk app: it gets cards only, never grants. */
export function isHighRiskComputerCall(tool: ToolSpec, args: unknown): boolean {
  return tool.source === 'computer' && isHighRiskApp(args);
}
