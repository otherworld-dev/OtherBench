/**
 * The Code tab's terminals (spec 2026-10-21-code-terminal-design): shells the
 * server runs for an app, shown in the Code panel's Terminal tab. Never a
 * model tool, never synced, never on the peer listener.
 */

/** A shell this machine can start, picked by `id` (never by path). */
export interface ShellInfo {
  id: string;
  label: string;
  default: boolean;
}

/** One running (or exited) terminal of an app. Lives in the server's memory only. */
export interface TerminalInfo {
  id: string;
  appId: string;
  name: string;
  shellId: string;
  /** Null while the shell runs; its exit code once it has ended. */
  exitCode: number | null;
  createdAt: number;
}

/** `not-local`: this server is reachable from elsewhere (sign-in mode, a non-loopback bind). `no-pty`: the PTY module didn't load here. */
export type TerminalUnavailableReason = 'not-local' | 'no-pty';

/** `GET /api/terminal/status`. */
export interface TerminalStatus {
  available: boolean;
  reason?: TerminalUnavailableReason;
  shells: ShellInfo[];
}

/** At most this many terminals per app, and in all. */
export const TERMINALS_PER_APP = 10;
export const TERMINALS_TOTAL = 30;
