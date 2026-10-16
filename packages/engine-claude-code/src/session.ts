import type { CanonMessage } from '@otherbench/core/types/messages.js';

export type SessionPlan = { mode: 'continue'; sessionId: string } | { mode: 'fresh' };

/**
 * In-process claims on "continue session X in place". Compare siblings or a
 * fast double-send can both see the same message as the session tip; the
 * first claim continues it, the rest start fresh. Released when the turn ends.
 */
export class SessionClaims {
  private readonly held = new Set<string>();
  tryClaim(sessionId: string): boolean {
    if (this.held.has(sessionId)) return false;
    this.held.add(sessionId);
    return true;
  }
  release(sessionId: string): void {
    this.held.delete(sessionId);
  }
}

export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/**
 * Chooses how this turn's Claude Code session starts, from the assistant
 * message directly above the new user message (spec §2, as amended by R12):
 *  - same backend + workspace, and that message is the session's tip and not
 *    claimed by an in-flight turn -> continue in place;
 *  - anything else -> a fresh session seeded with OtherBench's history.
 *
 * There is deliberately no "resume with fork" mode. Sessions are continued in
 * place, so once a message stops being its session's tip the session also
 * holds turns from other branches (a retried errored reply, the reply an edit
 * replaced, a compare sibling's turn). `forkSession` copies the WHOLE session,
 * so a fork would hand the model that other branch's history. A fresh session
 * seeded from OtherBench's own branch history is always correct.
 */
export function pickSession(input: {
  history: CanonMessage[];
  backend: string;
  cwd: string;
  latestMessageForSession?: (sessionId: string) => string | null;
  claims: SessionClaims;
}): SessionPlan {
  const turns = input.history.filter((m) => m.role !== 'system');
  const previous = turns.length >= 2 ? turns[turns.length - 2] : undefined;
  const meta = previous?.role === 'assistant' ? previous.engineMeta : undefined;
  if (!previous || !meta || meta.engine !== 'claude_code' || !input.latestMessageForSession) return { mode: 'fresh' };
  if (meta.backend !== input.backend || !samePath(meta.cwd, input.cwd)) return { mode: 'fresh' };
  const isTip = input.latestMessageForSession(meta.sessionId) === previous.id;
  if (isTip && input.claims.tryClaim(meta.sessionId)) return { mode: 'continue', sessionId: meta.sessionId };
  return { mode: 'fresh' };
}
