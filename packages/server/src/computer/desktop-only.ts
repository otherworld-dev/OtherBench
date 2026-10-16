import type { MiddlewareHandler } from 'hono';
import { COMPUTER_DESKTOP_ONLY_REASON, COMPUTER_DESKTOP_ONLY_UNCONFIRMED_REASON } from '@otherbench/core/domain/computer-apps.js';

/** What the gate needs to know about computer use on this machine. */
export interface ComputerHold {
  /** True while a chat holds the computer, its start dialog may be up, or an end isn't confirmed yet. */
  mayBeInControl(): boolean;
  /** The chat that holds the computer or whose start dialog may be up; null when none does (an end may still be unconfirmed). */
  holder(): string | null;
}

/** Writes that only ever stop something, which anyone may still send: the banner's Stop and a reply's Stop. */
const ALWAYS_ALLOWED: readonly RegExp[] = [/^(?:\/api)?\/chats\/[^/]+\/computer\/stop$/, /^(?:\/api)?\/messages\/[^/]+\/cancel$/];

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * While computer use may be in control of this machine, the API takes a
 * change (a card's answer, a question's or plan's, a message, a profile, an
 * MCP server, a setting) only from the desktop app's own window, which is
 * the one window computer use never acts in. Its requests carry its own
 * `Origin` (`desktopOrigins`, the shell's `--cors-origin`s), which a page
 * can't set. Anything else is refused with 403 and
 * `COMPUTER_DESKTOP_ONLY_REASON` (or, when no chat holds the computer but an
 * end is unconfirmed, `COMPUTER_DESKTOP_ONLY_UNCONFIRMED_REASON`, which says
 * a restart clears it): a browser tab of OtherBench (same origin, or a
 * request with no `Origin` at all), and so a model holding a lasting grant
 * for that browser, which could otherwise open OtherBench there and answer its own
 * cards, or post a message to a chat whose grants would run it with no card.
 * Reads, and the two Stops, always pass.
 *
 * On the desktop server the per-launch API token is the real barrier against
 * a browser tab or any other program driving the API: a tab can't send it
 * (and `otherbench serve` keeps it out of every child process's environment).
 * This gate is defence in depth that stops a browser that somehow could, and
 * the first wall is that computer use refuses any window whose title carries
 * OtherBench's marker (core's `classifyTarget`, and the shell before every step).
 * It doesn't cover another OtherBench server the browser can reach, which has no
 * computer session of its own.
 *
 * `allowed`: the origins that count as the desktop app. Empty (the peer
 * listener): nothing does.
 */
export function changesOnlyFromTheDesktopApp(hold: ComputerHold | undefined, allowed: readonly string[]): MiddlewareHandler {
  const origins = new Set(allowed);
  return async (c, next) => {
    if (READS.has(c.req.method) || hold === undefined || !hold.mayBeInControl()) return next();
    const path = c.req.path;
    if (ALWAYS_ALLOWED.some((route) => route.test(path))) return next();
    const origin = c.req.header('Origin');
    if (origin !== undefined && origins.has(origin)) return next();
    // No chat holds it, but an end isn't confirmed: say what clears that (the desktop app answering, or a restart).
    const reason = hold.holder() === null ? COMPUTER_DESKTOP_ONLY_UNCONFIRMED_REASON : COMPUTER_DESKTOP_ONLY_REASON;
    return c.json({ error: reason, kind: 'desktop_only' }, 403);
  };
}
