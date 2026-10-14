import type { MiddlewareHandler } from 'hono';
import { COMPUTER_DESKTOP_ONLY_REASON } from '@grunt/core/domain/computer-apps.js';

/** What the gate needs to know about computer use on this machine. */
export interface ComputerHold {
  /** True while a chat holds the computer, its start dialog may be up, or an end isn't confirmed yet. */
  mayBeInControl(): boolean;
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
 * `COMPUTER_DESKTOP_ONLY_REASON`: a browser tab of Grunt (same origin, or a
 * request with no `Origin` at all), and so a model holding a lasting grant
 * for that browser, which could otherwise open Grunt there and answer its own
 * cards, or post a message to a chat whose grants would run it with no card.
 * Reads, and the two Stops, always pass.
 *
 * This is the second wall. The first is that computer use refuses any window
 * whose title carries Grunt's marker (core's `classifyTarget`, and the shell
 * before every step); this one holds if a page of Grunt is ever shown
 * without it.
 *
 * `allowed`: the origins that count as the desktop app. Empty (the peer
 * listener): nothing does.
 */
export function changesOnlyFromTheDesktopApp(hold: ComputerHold | undefined, allowed: readonly string[]): MiddlewareHandler {
  const origins = new Set(allowed);
  return async (c, next) => {
    if (READS.has(c.req.method) || hold === undefined || !hold.mayBeInControl()) return next();
    const path = new URL(c.req.url).pathname;
    if (ALWAYS_ALLOWED.some((route) => route.test(path))) return next();
    const origin = c.req.header('Origin');
    if (origin !== undefined && origins.has(origin)) return next();
    return c.json({ error: COMPUTER_DESKTOP_ONLY_REASON, kind: 'desktop_only' }, 403);
  };
}
