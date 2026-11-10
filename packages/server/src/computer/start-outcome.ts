import type { ComputerAnswer } from '@otherbench/core/ports/computer.js';
import type { ComputerStartOutcome } from '@otherbench/core/types/events.js';
import { START_TIMEOUT_REASON } from './desktop-driver.js';

/**
 * The shell's own words for a start dialog answered Cancel, and for one that closed itself as Cancel after 110 s
 * (`DECLINED` and `UNANSWERED` in `desktop/src-tauri/src/computer/session.rs`; a test reads that file and checks
 * they still match). The shell answers a refused start with a reason only, no code, so these are how the server
 * tells the two apart.
 */
export const SHELL_START_DECLINED_REASON = "The user didn't let OtherBench control the computer.";
export const SHELL_START_UNANSWERED_REASON = "Nobody answered the desktop app's question in time, so OtherBench didn't take control.";

/**
 * How a start that a paired machine asked for ended, as that machine is told it (`computer-start` on `/peer/events`):
 * declined by the person here, unanswered (the dialog closed itself, or the shell didn't answer within the server's
 * own limit), or not started for any other reason. Null for a start that started. Only this word crosses: a reason
 * can carry the shell's or the server's wording of this machine's state, and stays in its log.
 */
export function startOutcomeOf(answer: ComputerAnswer): ComputerStartOutcome | null {
  if (answer.ok) return null;
  if (answer.reason === SHELL_START_DECLINED_REASON) return 'declined';
  if (answer.reason === SHELL_START_UNANSWERED_REASON || answer.reason === START_TIMEOUT_REASON) return 'unanswered';
  return 'not_started';
}
