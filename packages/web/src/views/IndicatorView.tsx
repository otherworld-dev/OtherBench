import { useEffect, useState, type JSX } from 'react';
import { onDesktopEvent, stopComputerControl } from '../desktop/bridge.js';
import { oneLine } from '../viewer/browser.js';

/**
 * The always-on-top bar the shell shows while a chat controls the computer
 * (desktop/src-tauri/src/computer/desktop.rs). It never talks to the server:
 * the chat's title comes in the URL, the last action from the shell's
 * `computer-indicator` event, and Stop is the shell's `computer_stop`, the
 * only command this window may call (capabilities/indicator.json).
 *
 * The title is the chat's (the model may have written it) and the last
 * action is the shell's own line (never typed text); both are shown as one
 * clean line inside a `<bdi>`.
 */
export function IndicatorView(): JSX.Element {
  const title = oneLine(new URLSearchParams(window.location.search).get('title')) || 'a chat';
  const [lastAction, setLastAction] = useState('');

  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    void onDesktopEvent<{ lastAction?: unknown }>('computer-indicator', (payload) => setLastAction(oneLine(payload?.lastAction))).then((unlisten) => {
      if (gone) unlisten();
      else off = unlisten;
    });
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  return (
    <div data-testid="computer-indicator" role="status" className="flex h-screen items-center gap-3 bg-[var(--bg-raised)] px-3 text-sm text-[var(--text)]">
      <span aria-hidden="true">{'\u{1F5B1}'}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className="truncate">Grunt is controlling this computer</strong>
        <span className="truncate text-xs text-[var(--text-muted)]">
          <bdi data-testid="computer-indicator-title">{title}</bdi>
          {lastAction !== '' && (
            <>
              {': '}
              <bdi data-testid="computer-indicator-last">{lastAction}</bdi>
            </>
          )}
        </span>
      </span>
      <button type="button" onClick={() => void stopComputerControl()} className="btn btn-danger px-2 py-1">
        Stop (Ctrl+Alt+Backspace)
      </button>
    </div>
  );
}
