import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { GitStatus } from '@otherbench/core/types/code.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { EditDiff } from '../components/EditDiff.js';
import { changedFiles, type ChangedFile } from '../lib/changedFiles.js';
import { api } from '../state/api.js';
import { machineName } from '../state/machines.js';
import { useOtherBenchStore } from '../state/store.js';
import { viewerActionsFor } from '../viewer/ViewerContext.js';
import { CodeErrorLine } from './CodeError.js';
import { GitPanel } from './GitPanel.js';
import { useCodeRefresh } from './useCodeRefresh.js';

type Popover = 'git' | 'changed';

/**
 * The bar above an app chat's thread (spec 2026-10-20-code-tab-design, Goal
 * 2 and Goal 6): the app's name, its branch (which opens the git panel), how
 * many files git sees changed, and how far the branch is ahead of or behind
 * its upstream (hidden with no upstream, "Error states"). Beside that, a pill
 * with the files this chat itself changed, from its own edit and write calls
 * (`changedFiles`), since several chats share the folder and git can't tell
 * them apart.
 *
 * The status is fetched on mount, when the window is focused, after a turn
 * finishes in one of the app's chats (`useCodeRefresh`, which also covers
 * this chat's own turns; the chats share one folder, so another's turn can
 * change what this one's bar should say), and from the ↻ button ("Calls I
 * made"). A folder that isn't a repo, isn't on this machine, or a machine
 * with no git shows the one line for it instead of the status.
 *
 * A chat that runs on another machine ("Decisions Adam made") still shows
 * this machine's status, says so, and its git panel is read-only: there is no
 * forwarding of git to the peer. The panel is read-only too while this
 * window hasn't loaded which machine it is.
 */
export function GitBar({ chat, messages }: { chat: Chat; messages: CanonMessage[] }): JSX.Element | null {
  const app = useOtherBenchStore((s) => s.apps.find((a) => a.id === chat.appId) ?? null);
  const machines = useOtherBenchStore((s) => s.machines);
  const setCodePanelTab = useOtherBenchStore((s) => s.setCodePanelTab);
  const appId = app?.id ?? '';
  const [status, setStatus] = useState<GitStatus | null>(null);
  // The last status that loaded, which an open git panel keeps showing when a refresh fails, so a failed
  // push's stderr isn't swept away by the refresh after it (the bar itself shows the failure).
  const [panelStatus, setPanelStatus] = useState<GitStatus | null>(null);
  const panelBusy = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<Popover | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLButtonElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  // Only the latest fetch may land: a slow one started before a refresh must not overwrite it.
  const seq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (appId === '') return;
    const mine = ++seq.current;
    try {
      const next = await api.apps.git.status(appId);
      if (mine !== seq.current) return;
      setStatus(next);
      setPanelStatus(next);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setStatus(null);
      setError(err);
    }
  }, [appId]);

  useEffect(() => {
    setStatus(null);
    setPanelStatus(null);
    setError(null);
    setOpen(null);
    void load();
  }, [load]);
  useCodeRefresh(appId, () => void load());

  // Pressing anywhere outside the bar and its popovers closes the open one.
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return;
      // Never under a running action: its outcome, and git's stderr if it failed, must stay to be read.
      if (panelBusy.current) return;
      setOpen(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const changed = useMemo(() => changedFiles(messages, app?.workspaceRoot), [messages, app?.workspaceRoot]);

  if (!app) return null;

  const elsewhere = machines !== null && chat.runsOn !== machines.self.id;
  // Until this window knows which machine it is, it can't tell that the chat runs here, so nothing may change git yet.
  const readOnly = machines === null || elsewhere;
  const closeTo = (ref: RefObject<HTMLButtonElement | null>) => (): void => {
    setOpen(null);
    ref.current?.focus();
  };
  const toggle = (which: Popover): void => setOpen((o) => (o === which ? null : which));

  const openInFiles = (path: string): void => {
    // As the Files tab opens a file with an app chat focused: in this chat's viewer, with the panel on Files.
    setCodePanelTab('files');
    viewerActionsFor(chat.id).openPath(path);
    setOpen(null);
  };

  return (
    <div
      ref={rootRef}
      data-testid="git-bar"
      className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border)] px-4 py-1 text-xs text-[var(--text-muted)]"
    >
      <span className="font-medium text-[var(--text)]">{app.name}</span>
      {status !== null ? (
        <>
          <button
            ref={branchRef}
            type="button"
            data-testid="git-branch"
            aria-haspopup="dialog"
            aria-expanded={open === 'git'}
            title="Open the git panel"
            onClick={() => toggle('git')}
            className="rounded px-1 font-mono text-[var(--text)] hover:bg-[var(--bg-sunken)]"
          >
            <span aria-hidden="true">⎇ </span>
            <bdi>{status.branch ?? 'detached'}</bdi>
          </button>
          <span data-testid="git-changed-count">{`${status.files.length} changed`}</span>
          {status.upstream !== null && (
            <span data-testid="git-ahead-behind" title={`${status.ahead} ahead of and ${status.behind} behind ${status.upstream}`} className="tabular-nums">
              {`↑${status.ahead} ↓${status.behind}`}
            </span>
          )}
        </>
      ) : error !== null ? (
        // git's stderr as-is for a git-failed status ("Error states"); the known states are their one line.
        <CodeErrorLine error={error} fallback="Couldn't read the git status." testId="git-bar-error" />
      ) : (
        <span className="text-[var(--text-faint)]">Loading…</span>
      )}
      {elsewhere && <span data-testid="git-runs-elsewhere">{`Runs on ${machineName(machines, chat.runsOn)}: git shows this machine's copy`}</span>}
      {changed.length > 0 && (
        <button
          ref={pillRef}
          type="button"
          data-testid="changed-in-chat"
          aria-haspopup="dialog"
          aria-expanded={open === 'changed'}
          onClick={() => toggle('changed')}
          className="chip px-2"
        >
          {`${changed.length} ${changed.length === 1 ? 'file' : 'files'} changed in this chat`} <span aria-hidden="true">▾</span>
        </button>
      )}
      <button
        type="button"
        aria-label="Refresh git status"
        title="Refresh git status"
        onClick={() => void load()}
        className="ml-auto rounded px-1 hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
      >
        <span aria-hidden="true">↻</span>
      </button>
      {open === 'git' && panelStatus !== null && (
        <GitPanel
          app={app}
          status={panelStatus}
          readOnly={readOnly}
          onChanged={load}
          onClose={closeTo(branchRef)}
          onBusyChange={(b) => {
            panelBusy.current = b;
          }}
        />
      )}
      {open === 'changed' && <ChangedList files={changed} onOpen={openInFiles} onClose={closeTo(pillRef)} />}
    </div>
  );
}

/**
 * The "changed in this chat" popover (spec 2026-10-20-code-tab-design, Goal
 * 6): the chat's files with their +/− counts; a file shows the chat's own
 * edits to it ("Calls I made": not the current git diff, which the git panel
 * shows), with a button to open it in Files.
 */
function ChangedList({ files, onOpen, onClose }: { files: ChangedFile[]; onOpen: (path: string) => void; onClose: () => void }): JSX.Element {
  const [shown, setShown] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus();
  }, []);
  const file = shown === null ? null : (files.find((f) => f.path === shown) ?? null);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Changed in this chat"
      data-testid="changed-in-chat-list"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="absolute left-2 right-2 top-full z-30 mt-1 flex max-h-[60vh] max-w-3xl flex-col gap-2 overflow-auto rounded border border-[var(--border)] bg-[var(--bg-raised)] p-3 text-sm text-[var(--text)] shadow-lg outline-none"
    >
      {file === null ? (
        <>
          <p className="text-xs text-[var(--text-muted)]">From this chat's own edits, in every branch. Shell commands' changes aren't listed.</p>
          <ul aria-label="Files changed in this chat" className="flex flex-col">
            {files.map((f) => (
              <li key={f.path} data-path={f.path}>
                <button type="button" onClick={() => setShown(f.path)} className="flex w-full items-center gap-3 rounded px-2 py-1 text-left hover:bg-[var(--bg-sunken)]">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                    <bdi>{f.path}</bdi>
                  </span>
                  <span className="shrink-0 tabular-nums text-xs text-[var(--diff-add-text)]">{`+${f.added}`}</span>
                  <span className="shrink-0 tabular-nums text-xs text-[var(--diff-del-text)]">{`−${f.removed}`}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setShown(null)} aria-label="Back to the changed files" className="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
              <span aria-hidden="true">← Files</span>
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
              <bdi>{file.path}</bdi>
            </span>
            <button type="button" className="btn shrink-0 px-2 py-0.5 text-xs" onClick={() => onOpen(file.path)}>
              Open in Files
            </button>
          </div>
          {file.edits.map((e, i) => (
            <EditDiff key={i} info={e} defaultOpen />
          ))}
        </>
      )}
    </div>
  );
}
