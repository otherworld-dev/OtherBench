import type { JSX } from 'react';
import { COMPUTER_DESKTOP_ONLY_REASON, COMPUTER_DESKTOP_ONLY_UNCONFIRMED_REASON } from '@otherbench/core/domain/computer-apps.js';
import { isDesktop } from '../desktop/bridge.js';
import { ApiError } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';

/**
 * What a card says when its answer didn't go through: the server's own words
 * when it refused because computer use may be in control of this machine and
 * the answer didn't come from the desktop app's window
 * (`COMPUTER_DESKTOP_ONLY_REASON`), else `fallback`.
 */
export function answerErrorText(err: unknown, fallback: string): string {
  const known = err instanceof ApiError && err.status === 403 && (err.message === COMPUTER_DESKTOP_ONLY_REASON || err.message === COMPUTER_DESKTOP_ONLY_UNCONFIRMED_REASON);
  return known ? (err as ApiError).message : fallback;
}

/**
 * On a card shown anywhere but the desktop app's own window (a browser tab, a
 * remote device) while a chat is controlling the computer: the server takes
 * answers only from the desktop app until that ends, so the card says so
 * before anyone tries. The buttons stay, since the server is what decides.
 * The app knows only of sessions in control (the `computer-session` events):
 * while a start dialog is up, or an end is unconfirmed, the note isn't
 * shown, and a refused answer shows the server's own reason instead.
 */
export function DesktopOnlyNote(): JSX.Element | null {
  const controlling = useOtherBenchStore((s) => Object.keys(s.computerSessions).length > 0);
  if (!controlling || isDesktop()) return null;
  return (
    <p data-testid="desktop-only-note" className="text-xs text-[var(--warn)]">
      OtherBench is controlling this computer. Until that ends, answer this in the OtherBench app on this computer.
    </p>
  );
}
