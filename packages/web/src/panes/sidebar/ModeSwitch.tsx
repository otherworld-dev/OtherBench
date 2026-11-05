import type { JSX } from 'react';
import { DockIcon, PopOutIcon } from '../../components/icons.js';
import { dock, undock } from '../../desktop/bridge.js';
import { inDesktopApp, windowForMode, type DockView } from '../../desktop/windows.js';
import type { Mode } from '../../state/mode.js';
import { selectOverviewTotal, useOtherBenchStore, WINDOW_ROLE } from '../../state/store.js';

/**
 * The Chat | Code | Overview switch at the top of the sidebar (spec 2026-10-20-code-tab-design, Goal 1), and in the
 * desktop app the button beside it that moves what is showing into a window of its own or back.
 */
export function ModeSwitch(): JSX.Element {
  const mode = useOtherBenchStore((s) => s.mode);
  const setMode = useOtherBenchStore((s) => s.setMode);
  const overviewOpen = useOtherBenchStore((s) => s.overviewOpen);
  const setOverviewOpen = useOtherBenchStore((s) => s.setOverviewOpen);
  const overviewTotal = useOtherBenchStore(selectOverviewTotal);
  const undocked = useOtherBenchStore((s) => s.undocked);

  // Undocked windows (desktop/windows.ts): a mode or the Overview in a window of its own is marked so,
  // and choosing it brings that window forward (the store's setMode and setOverviewOpen do).
  const modeElsewhere = (m: Mode): boolean => windowForMode(m, undocked, WINDOW_ROLE) !== WINDOW_ROLE;
  const overviewElsewhere = undocked.includes('overview');
  const elsewhereMark = <PopOutIcon className="h-3 w-3 shrink-0 opacity-70" />;
  // What the button beside the switch does with what is showing: the Overview or Code mode out to a
  // window of its own, or, in the Code window, Code back into the main one. Chat mode stays in the main window.
  const dockAction: { view: DockView; out: boolean; label: string } | null = !inDesktopApp()
    ? null
    : overviewOpen
      ? { view: 'overview', out: true, label: 'Open the Overview in its own window' }
      : WINDOW_ROLE === 'code'
        ? { view: 'code', out: false, label: 'Put Code back in the main window' }
        : mode === 'code'
          ? { view: 'code', out: true, label: 'Open Code in its own window' }
          : null;

  return (
    <div className="mb-2 flex items-stretch gap-1">
      <div role="group" aria-label="Mode" data-testid="mode-switch" className="grid min-w-0 flex-1 grid-cols-[minmax(3rem,1fr)_minmax(3rem,1fr)_minmax(0,auto)] gap-0.5 rounded-sm border border-[var(--border-strong)] bg-[var(--bg)] p-0.5">
        {(['chat', 'code'] as const satisfies readonly Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m && !overviewOpen && !modeElsewhere(m)}
            onClick={() => setMode(m)}
            title={modeElsewhere(m) ? `${m === 'chat' ? 'Chat' : 'Code'} is in its own window` : undefined}
            className={`flex min-w-0 items-center justify-center gap-1 overflow-hidden rounded-[3px] px-2 py-1 text-xs ${
              mode === m && !overviewOpen && !modeElsewhere(m) ? 'bg-[var(--bg-raised)] font-medium text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
          >
            <span className="truncate">{m === 'chat' ? 'Chat' : 'Code'}</span>
            {modeElsewhere(m) && elsewhereMark}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={overviewOpen}
          onClick={() => setOverviewOpen(true)}
          title={overviewElsewhere ? 'The Overview is in its own window' : undefined}
          className={`flex min-w-0 items-center justify-center gap-1 overflow-hidden rounded-[3px] px-2 py-1 text-xs ${
            overviewOpen ? 'bg-[var(--bg-raised)] font-medium text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
          }`}
        >
          <span className="truncate">Overview</span>
          {overviewTotal > 0 && (
            <span data-testid="overview-count" className="shrink-0 rounded-full bg-[var(--accent)] px-1.5 text-[0.65rem] tabular-nums text-[var(--bg)]">
              {overviewTotal}
            </span>
          )}
          {overviewElsewhere && elsewhereMark}
        </button>
      </div>
      {dockAction && (
        <button
          type="button"
          data-testid="dock-toggle"
          aria-label={dockAction.label}
          title={dockAction.label}
          onClick={() => {
            (dockAction.out ? undock(dockAction.view) : dock(dockAction.view)).catch((err: unknown) =>
              console.error(`[otherbench-web] failed to ${dockAction.out ? 'undock' : 'dock'} ${dockAction.view}:`, err),
            );
          }}
          className="btn shrink-0 px-1.5"
        >
          {dockAction.out ? <PopOutIcon /> : <DockIcon />}
        </button>
      )}
    </div>
  );
}
