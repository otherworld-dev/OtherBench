import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { App } from '@otherbench/core/ports/store.js';
import type { GitFileChange, GitStatus } from '@otherbench/core/types/code.js';
import { EditDiff } from '../components/EditDiff.js';
import { diffTruncated, parseUnifiedDiff, type DiffLine } from '../lib/editDiff.js';
import { api, type GitBranch } from '../state/api.js';
import { CodeErrorLine } from './CodeError.js';

export interface GitPanelProps {
  app: App;
  /** The status the git bar holds; a new object each time it is fetched, which is what refetches the diff and branches here. */
  status: GitStatus;
  /** The chat runs on another machine: everything shows, but nothing here may change this machine's copy. */
  readOnly: boolean;
  /** Fetch the status again (the git bar's own refresh); awaited after every action. */
  onChanged: () => void | Promise<void>;
  onClose: () => void;
}

/** git's XY letters as one short code: `??` for an untracked file, else the letters that aren't blank. */
function statusCode(f: GitFileChange): string {
  if (f.index === '?' && f.worktree === '?') return '??';
  return `${f.index}${f.worktree}`.replace(/ /g, '');
}

type Outcome = { kind: 'ok'; text: string } | { kind: 'error'; error: unknown };

/**
 * The git panel the git bar's branch opens (spec 2026-10-20-code-tab-design,
 * Goal 2): Adam's own git actions beside the chat, for when he'd rather do
 * them by hand than ask Claude. It shows every changed file with the real
 * `git diff` (unlike the "changed in this chat" list, which shows the chat's
 * own edits), each with a checkbox for the commit (all checked by default,
 * and "all" is sent as `'all'` so a file appearing meanwhile goes in too),
 * Pull and Push (Push sets the upstream when there is none, "Error states"),
 * and a branch picker with a "New branch" box. A failure shows git's stderr
 * as-is and nothing tries to recover from it. Every action, failed or not,
 * ends by fetching the status again, which in turn refetches the diff and the
 * branches. With `readOnly` (the chat runs on another machine, "Decisions
 * Adam made") the actions are off; the status and diffs still show, since
 * they are this machine's copy and say so in the bar.
 */
export function GitPanel({ app, status, readOnly, onChanged, onClose }: GitPanelProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [diff, setDiff] = useState<{ files: Map<string, DiffLine[]>; truncated: boolean } | null>(null);
  const [diffError, setDiffError] = useState<unknown>(null);
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [branchesError, setBranchesError] = useState<unknown>(null);
  // Unchecked rather than checked, so a file that shows up on a refresh starts checked like the rest.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // Each status fetch (an action, focus, a finished turn, the bar's ↻) brings the diff and branch list up to date with it.
  useEffect(() => {
    let cancelled = false;
    api.apps.git.diff(app.id).then(
      ({ diff: text }) => {
        if (cancelled) return;
        setDiff({ files: new Map(parseUnifiedDiff(text).map((f) => [f.path, f.lines])), truncated: diffTruncated(text) });
        setDiffError(null);
      },
      (err: unknown) => !cancelled && setDiffError(err)
    );
    api.apps.git.branches(app.id).then(
      (r) => {
        if (cancelled) return;
        setBranches(r.branches);
        setBranchesError(null);
      },
      (err: unknown) => !cancelled && setBranchesError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [app.id, status]);

  const checked = status.files.filter((f) => !unchecked.has(f.path));
  const allChecked = checked.length === status.files.length;
  const noUpstream = status.upstream === null;

  // The current branch is always offered, even before the list arrives or on an unborn branch it doesn't list.
  const branchNames = useMemo(() => {
    const names = (branches ?? []).map((b) => b.name);
    if (status.branch !== null && !names.includes(status.branch)) names.unshift(status.branch);
    return names;
  }, [branches, status.branch]);

  async function run(action: () => Promise<string | null>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setOutcome(null);
    let ok = false;
    try {
      const text = await action();
      setOutcome(text === null ? null : { kind: 'ok', text });
      ok = true;
    } catch (error) {
      setOutcome({ kind: 'error', error });
    } finally {
      // A failed pull or push can still have moved something (a fetch, a half-done merge), so the status is fetched either way.
      try {
        await onChanged();
      } finally {
        setBusy(false);
      }
    }
    return ok;
  }

  const commit = async (): Promise<void> => {
    const text = message;
    const done = await run(async () => {
      const { sha } = await api.apps.git.commit(app.id, { message: text, paths: allChecked ? 'all' : checked.map((f) => f.path) });
      return `Committed ${sha.slice(0, 7)}`;
    });
    if (done) {
      setMessage('');
      setUnchecked(new Set());
    }
  };
  const pull = (): void => void run(async () => (await api.apps.git.pull(app.id)).output.trim() || 'Pulled.');
  const push = (): void =>
    void run(async () => (await (noUpstream ? api.apps.git.push(app.id, { setUpstream: true }) : api.apps.git.push(app.id))).output.trim() || 'Pushed.');
  const checkout = (name: string): void => {
    if (name === status.branch) return;
    void run(async () => {
      await api.apps.git.checkout(app.id, name);
      return null;
    });
  };
  const createBranch = async (): Promise<void> => {
    const name = newBranch.trim();
    if (name === '') return;
    if (await run(async () => {
      await api.apps.git.branch(app.id, name);
      return null;
    })) setNewBranch('');
  };

  const toggle = (path: string): void =>
    setUnchecked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Git"
      data-testid="git-panel"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="absolute left-2 right-2 top-full z-30 mt-1 flex max-h-[60vh] max-w-3xl flex-col gap-3 overflow-auto rounded border border-[var(--border)] bg-[var(--bg-raised)] p-3 text-sm shadow-lg outline-none"
    >
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate font-medium">{`Git · ${app.name}`}</h2>
        <button type="button" onClick={onClose} aria-label="Close git panel" className="shrink-0 rounded px-1 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]">
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {readOnly && <p className="text-xs text-[var(--text-muted)]">This chat runs on another machine, so commit, pull, push and branch changes are off here.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span>Branch</span>
          <select
            aria-label="Branch"
            value={status.branch ?? ''}
            disabled={readOnly || busy}
            onChange={(e) => checkout(e.target.value)}
            className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-sm text-[var(--text)]"
          >
            {status.branch === null && <option value="" disabled>(detached)</option>}
            {branchNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          aria-label="New branch"
          placeholder="New branch"
          value={newBranch}
          disabled={readOnly}
          onChange={(e) => setNewBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void createBranch();
            }
          }}
          className="w-40 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-sm"
        />
        <button type="button" className="btn px-2 py-0.5" disabled={readOnly || busy || newBranch.trim() === ''} onClick={() => void createBranch()}>
          Create branch
        </button>
        <span className="flex-1" />
        <button type="button" className="btn px-2 py-0.5" disabled={readOnly || busy} onClick={pull}>
          Pull
        </button>
        <button type="button" className="btn px-2 py-0.5" disabled={readOnly || busy} onClick={push}>
          {noUpstream ? 'Push and set upstream' : 'Push'}
        </button>
      </div>
      {branchesError !== null && <CodeErrorLine error={branchesError} fallback="Couldn't list the branches." />}

      {outcome?.kind === 'error' && <CodeErrorLine error={outcome.error} fallback="That git action failed." testId="git-action-error" />}
      {outcome?.kind === 'ok' && (
        <pre data-testid="git-output" className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-xs text-[var(--text-muted)]">
          {outcome.text}
        </pre>
      )}

      {status.files.length === 0 ? (
        <p className="text-[var(--text-muted)]">No changes</p>
      ) : (
        <ul aria-label="Changed files" className="flex flex-col gap-1">
          {status.files.map((f) => {
            const lines = diff?.files.get(f.path);
            return (
              <li key={f.path} data-path={f.path} className="flex items-start gap-2">
                <input type="checkbox" aria-label={f.path} checked={!unchecked.has(f.path)} onChange={() => toggle(f.path)} className="mt-2 shrink-0" />
                <span title="git status" className="mt-1.5 w-5 shrink-0 font-mono text-xs text-[var(--text-muted)]">
                  {statusCode(f)}
                </span>
                <div className="min-w-0 flex-1">
                  {lines && lines.length > 0 ? (
                    <EditDiff
                      info={{ path: f.path, lines, added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length, isNewFile: false }}
                    />
                  ) : (
                    <p className="mt-1 truncate font-mono text-xs" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
                      <bdi>{f.path}</bdi>
                      {diff !== null && <span className="ml-2 font-sans text-[var(--text-faint)]">no text diff</span>}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {diff?.truncated && <p className="text-xs text-[var(--text-muted)]">The diff is too long, so only its start is shown.</p>}
      {diffError !== null && <CodeErrorLine error={diffError} fallback="Couldn't read the diff." />}

      <div className="flex flex-col gap-1.5">
        <textarea
          aria-label="Commit message"
          placeholder="Commit message"
          rows={2}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-sm"
        />
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-[var(--text-muted)]">
            {status.files.length === 0 ? '' : allChecked ? 'All files' : `${checked.length} of ${status.files.length} files`}
          </span>
          <button
            type="button"
            className="btn btn-primary px-3 py-0.5"
            disabled={readOnly || busy || message.trim() === '' || checked.length === 0}
            onClick={() => void commit()}
          >
            Commit
          </button>
        </div>
      </div>
    </div>
  );
}
