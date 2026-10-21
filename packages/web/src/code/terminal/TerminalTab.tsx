import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { App } from '@otherbench/core/ports/store.js';
import type { TerminalInfo } from '@otherbench/core/types/terminal.js';
import { api, ApiError } from '../../state/api.js';
import { useOtherBenchStore } from '../../state/store.js';
import { CodeErrorLine } from '../CodeError.js';
import { rememberSelectedTerminal, selectedTerminal } from './selection.js';
import { useTerminalStatus } from './status.js';
import { TerminalView } from './TerminalView.js';

/** What a new terminal starts at; the view fits it to the panel straight away. */
const START_SIZE = { cols: 80, rows: 24 };

/**
 * The Code panel's Terminal tab (spec 2026-10-21-code-terminal-design): the
 * focused app's terminals as a strip of tabs, and the selected one's screen.
 * Only that one is mounted, so only it streams; the others keep running in
 * the server and catch up from its buffer when shown again. Opening the tab
 * on an app with none starts one, as VS Code does.
 */
export function TerminalTab({ app }: { app: App }): JSX.Element {
  const status = useTerminalStatus();
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(() => selectedTerminal(app.id));
  const [error, setError] = useState<unknown>(null);
  const [notHere, setNotHere] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  // Bumped by Restart, so the screen starts clean with the new process's output.
  const [epochs, setEpochs] = useState<Record<string, number>>({});
  const startedOne = useRef(false);

  const select = useCallback(
    (id: string) => {
      setSelected(id);
      rememberSelectedTerminal(app.id, id);
    },
    [app.id]
  );

  const refresh = useCallback(async (): Promise<TerminalInfo[] | null> => {
    try {
      const list = await api.terminals.list(app.id);
      setTerminals(list);
      return list;
    } catch (err) {
      setError(err);
      return null;
    }
  }, [app.id]);

  const create = useCallback(
    async (shell?: string) => {
      setError(null);
      setMenuOpen(false);
      try {
        const t = await api.terminals.create(app.id, { ...(shell !== undefined ? { shell } : {}), ...START_SIZE });
        setTerminals((prev) => (prev === null ? [t] : prev.some((x) => x.id === t.id) ? prev : [...prev, t]));
        select(t.id);
        setFocusToken((n) => n + 1);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not-on-this-machine') setNotHere(true);
        setError(err);
      }
    },
    [app.id, select]
  );

  useEffect(() => {
    void refresh().then((list) => {
      if (list !== null && list.length === 0 && !startedOne.current) {
        startedOne.current = true;
        void create();
      }
    });
  }, [refresh, create]);

  // Another window, the other tab of this one, or a shell that ended: re-read the list.
  useEffect(
    () =>
      useOtherBenchStore.subscribe((state, prev) => {
        const changed = state.terminalsChanged;
        if (changed !== null && changed !== prev.terminalsChanged && changed.appId === app.id) void refresh();
      }),
    [app.id, refresh]
  );

  // Ctrl+` and Ctrl+Shift+` (useTerminalShortcuts).
  const latest = useRef({ terminals, create });
  latest.current = { terminals, create };
  useEffect(
    () =>
      useOtherBenchStore.subscribe((state, prev) => {
        const request = state.terminalRequest;
        if (request === null || request === prev.terminalRequest) return;
        const { terminals: now, create: make } = latest.current;
        if (request.kind === 'new' || (now !== null && now.length === 0)) void make();
        else setFocusToken((n) => n + 1);
      }),
    []
  );

  const current = terminals?.find((t) => t.id === selected) ?? terminals?.[0] ?? null;

  async function kill(t: TerminalInfo): Promise<void> {
    setError(null);
    try {
      await api.terminals.kill(app.id, t.id);
    } catch (err) {
      setError(err);
    }
    await refresh();
  }

  async function rename(t: TerminalInfo, name: string): Promise<void> {
    setRenaming(null);
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === t.name) return;
    try {
      await api.terminals.rename(app.id, t.id, trimmed);
    } catch (err) {
      setError(err);
    }
    await refresh();
  }

  async function restart(t: TerminalInfo): Promise<void> {
    setError(null);
    try {
      await api.terminals.restart(app.id, t.id);
      setEpochs((e) => ({ ...e, [t.id]: (e[t.id] ?? 0) + 1 }));
      setFocusToken((n) => n + 1);
    } catch (err) {
      setError(err);
    }
    await refresh();
  }

  const shells = status?.shells ?? [];

  return (
    <div data-testid="terminal-tab" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1">
        <div role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {(terminals ?? []).map((t) =>
            renaming === t.id ? (
              <input
                key={t.id}
                aria-label="Terminal name"
                defaultValue={t.name}
                maxLength={60}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void rename(t, e.currentTarget.value);
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlur={() => setRenaming(null)}
                className="w-28 rounded border border-[var(--border)] bg-[var(--bg)] px-1 text-xs"
              />
            ) : (
              <span key={t.id} className={`flex shrink-0 items-center rounded ${t.id === current?.id ? 'bg-[var(--bg)]' : ''}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={t.id === current?.id}
                  title={t.exitCode === null ? 'Double-click to rename' : `Exited with code ${t.exitCode}`}
                  onClick={() => {
                    select(t.id);
                    setFocusToken((n) => n + 1);
                  }}
                  onDoubleClick={() => setRenaming(t.id)}
                  className={`px-2 py-0.5 text-xs ${t.exitCode === null ? 'text-[var(--text)]' : 'text-[var(--text-faint)] line-through'}`}
                >
                  {t.name}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${t.name}`}
                  title="Close (ends the shell and everything it started)"
                  onClick={() => void kill(t)}
                  className="px-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  ✕
                </button>
              </span>
            )
          )}
        </div>
        <div className="relative flex shrink-0 items-center">
          <button type="button" aria-label="New terminal" title="New terminal (Ctrl+Shift+`)" disabled={notHere} onClick={() => void create()} className="btn px-1.5 py-0 text-sm">
            +
          </button>
          <button
            type="button"
            aria-label="Choose a shell"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={notHere || shells.length === 0}
            onClick={() => setMenuOpen((o) => !o)}
            className="btn ml-0.5 px-1 py-0 text-xs"
          >
            ▾
          </button>
          {menuOpen && (
            <div role="menu" aria-label="Shells" className="absolute right-0 top-full z-30 mt-1 min-w-40 rounded border border-[var(--border)] bg-[var(--bg-raised)] py-1 shadow">
              {shells.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  onClick={() => void create(s.id)}
                  className="block w-full px-3 py-1 text-left text-xs hover:bg-[var(--bg-sunken)]"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {error !== null && (
        <div className="px-3 py-2">
          <CodeErrorLine error={error} fallback="Couldn't do that with the terminal." />
        </div>
      )}
      {current && !notHere && (
        <div className="relative min-h-0 flex-1">
          <TerminalView key={`${current.id}:${epochs[current.id] ?? 0}`} appId={app.id} terminal={current} focusToken={focusToken} />
          {current.exitCode !== null && (
            <div data-testid="terminal-exited" className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-[var(--border)] bg-[var(--bg-raised)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
              <span>Process exited with code {current.exitCode}</span>
              <button type="button" onClick={() => void restart(current)} className="btn px-2 py-0.5">
                Restart
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
