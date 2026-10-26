import { useEffect, useState, type JSX } from 'react';
import { ISSUE_LIST_LIMIT } from '@otherbench/core/domain/apps.js';
import type { App } from '@otherbench/core/ports/store.js';
import { MarkdownBody } from '../components/MarkdownBody.js';
import { openInBrowser } from '../desktop/bridge.js';
import { formatAge, formatRelativeTime } from '../lib/relativeTime.js';
import { api } from '../state/api.js';
import { useOtherBenchStore, type IssueState } from '../state/store.js';
import { CodeErrorLine, NO_GITHUB_REPO } from './CodeError.js';
import { startChatFromIssue } from './startChatFromIssue.js';
import { stayInApp } from './stayInApp.js';
import { useCodeRefresh } from './useCodeRefresh.js';

/** The issue numbers of this app that are on the Overview, needing him. */
function useNeedingIssues(appId: string): Set<number> {
  const issues = useOtherBenchStore((s) => s.overview?.tiles.find((t) => t.appId === appId)?.issues);
  return new Set((issues ?? []).map((i) => i.number));
}

/** Ticks an issue off the Overview and stores the result; a failure is logged and the marker simply stays. */
function useTickIssue(appId: string): (n: number) => Promise<void> {
  const setOverview = useOtherBenchStore((s) => s.setOverview);
  return async (n) => {
    try {
      setOverview(await api.overview.tickIssue(appId, n));
    } catch (err) {
      console.error(`[otherbench-web] failed to tick off issue #${n}:`, err);
    }
  };
}

const MUTED = 'text-xs text-[var(--text-muted)]';
const EMPTY = 'text-sm text-[var(--text-faint)]';

/** gh's ISO time as a sidebar-style age ("3d"); an unreadable one shows nothing rather than "NaN". */
function age(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '' : formatAge(at);
}

function when(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '' : formatRelativeTime(at);
}

/**
 * The Code panel's Issues tab (spec 2026-10-20-code-tab-design, Goal 3): the
 * app's GitHub issues through the machine's own `gh`, newest first, open or
 * closed. A click shows one issue, where it can be commented on, closed or
 * reopened, or have a chat started on it (Goal 7). Each mutation answers 204,
 * so the issue is fetched again after it. Also the open-issues list on the
 * app home (`AppHome`), so the two always look and behave the same.
 *
 * Where it is (the state listed, the issue open) belongs to its `owner`, a
 * chat or an app home, and is kept in the store (`issueViews`): each chat has
 * its own, so an issue stays open in the chat working on it while another
 * chat shows its own.
 */
export function IssuesTab({ app, owner }: { app: App; owner: string }): JSX.Element {
  const view = useOtherBenchStore((s) => s.issueViews[owner]);
  const setIssueView = useOtherBenchStore((s) => s.setIssueView);
  const state = view?.state ?? 'open';
  const selected = view?.selected ?? null;
  return (
    <div data-testid="issues-tab" className="min-w-0">
      {selected === null ? (
        <IssueList app={app} state={state} onState={(s) => setIssueView(owner, { state: s })} onOpen={(n) => setIssueView(owner, { selected: n })} />
      ) : (
        <IssueView app={app} owner={owner} number={selected} onBack={() => setIssueView(owner, { selected: null })} />
      )}
    </div>
  );
}

function IssueList({ app, state, onState, onOpen }: { app: App; state: IssueState; onState: (s: IssueState) => void; onOpen: (n: number) => void }): JSX.Element {
  // gh's last answer for this list, shown while it's fetched again.
  const list = useOtherBenchStore((s) => s.issueLists[`${app.id}:${state}`] ?? null);
  const cacheIssueList = useOtherBenchStore((s) => s.cacheIssueList);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [starting, setStarting] = useState<number | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const repo = app.githubRepo;
  const needing = useNeedingIssues(app.id);
  const tick = useTickIssue(app.id);

  // A row's Chat button: the issue's text is fetched, as the list carries only its title, then the chat starts as from the issue itself.
  async function startOn(n: number): Promise<void> {
    if (starting !== null) return;
    setStarting(n);
    setStartError(null);
    try {
      await startChatFromIssue(app, await api.apps.issues.get(app.id, n));
    } catch (err) {
      console.error(`[otherbench-web] failed to start a chat on issue #${n}:`, err);
      setStartError(err);
    } finally {
      setStarting(null);
    }
  }

  // On focus and after a turn in one of the app's chats, as well as from ↻ (spec "Calls I made").
  useCodeRefresh(app.id, () => setReload((n) => n + 1));
  // Another app or state starts from its last list, or Loading…; a refresh keeps the list showing until the new one arrives.
  useEffect(() => setError(null), [app.id, repo, state]);
  useEffect(() => {
    // Nothing to ask gh about: the server would only answer no-github-repo.
    if (!repo) return;
    let cancelled = false;
    api.apps.issues.list(app.id, state).then(
      (r) => {
        if (cancelled) return;
        cacheIssueList(app.id, state, r);
        setError(null);
      },
      (err: unknown) => !cancelled && setError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [app.id, repo, state, reload, cacheIssueList]);

  // gh lists newest first already; sorted here too so the order never depends on it.
  const issues = list ? [...list.issues].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number) : null;
  // A list as long as the fetch limit was probably cut there, so it says "100+", not an exact count.
  const count = list ? (list.issues.length >= ISSUE_LIST_LIMIT ? `${ISSUE_LIST_LIMIT}+` : String(list.issues.length)) : '';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className={`min-w-0 flex-1 truncate ${MUTED}`}>{list ? `${list.repo} · ${count} ${state}` : (repo ?? '')}</p>
        <div role="group" aria-label="Issue state" className="flex shrink-0 rounded border border-[var(--border)] text-xs">
          {(['open', 'closed'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={state === s}
              onClick={() => onState(s)}
              className={`px-2 py-0.5 ${state === s ? 'bg-[var(--bg-sunken)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
            >
              {s === 'open' ? 'Open' : 'Closed'}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Refresh issues"
          title="Refresh issues"
          disabled={!repo}
          onClick={() => setReload((n) => n + 1)}
          className="shrink-0 rounded px-1 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] disabled:opacity-40"
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>
      {!repo ? (
        <div role="alert" className="text-sm text-[var(--text-muted)]">
          <p>{NO_GITHUB_REPO}</p>
        </div>
      ) : error !== null ? (
        <CodeErrorLine error={error} fallback="Couldn't load the issues." />
      ) : !issues ? (
        <p className={EMPTY}>Loading…</p>
      ) : issues.length === 0 ? (
        <p className={EMPTY}>{state === 'open' ? 'No open issues' : 'No closed issues'}</p>
      ) : (
        <>
          {startError !== null && <CodeErrorLine error={startError} fallback="Couldn't start the chat." />}
          <ul aria-label="Issues" className="space-y-0.5">
            {issues.map((issue) => (
              <li key={issue.number} data-issue={issue.number} className="flex items-start rounded-sm hover:bg-[var(--bg-sunken)]">
                <button
                  type="button"
                  data-testid={`issue-row-${issue.number}`}
                  onClick={() => onOpen(issue.number)}
                  className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1 text-left text-sm"
                >
                  <span className="shrink-0 tabular-nums text-[var(--text-faint)]">#{issue.number}</span>
                  <span className="min-w-0 flex-1">
                    <span className="[overflow-wrap:anywhere]">{issue.title}</span>
                    {issue.labels.length > 0 && (
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {issue.labels.map((l) => (
                          <span key={l} className="rounded-full border border-[var(--border)] px-1.5 text-[0.65rem] text-[var(--text-muted)]">
                            {l}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  {issue.comments > 0 && (
                    <span aria-label={`${issue.comments} ${issue.comments === 1 ? 'comment' : 'comments'}`} className="shrink-0 text-xs tabular-nums text-[var(--text-faint)]">
                      <span aria-hidden="true">💬 {issue.comments}</span>
                    </span>
                  )}
                  {needing.has(issue.number) && (
                    <span data-testid={`issue-needs-${issue.number}`} className="shrink-0 text-xs text-[var(--accent)]">
                      needs you
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-[var(--text-faint)]">{age(issue.createdAt)}</span>
                </button>
                {needing.has(issue.number) && (
                  <button type="button" aria-label={`Tick off #${issue.number}`} onClick={() => void tick(issue.number)} className="btn my-1 mr-1 shrink-0 px-1.5 py-0 text-xs">
                    Tick off
                  </button>
                )}
                {/* Beside the row's button, not in it: a button can't hold another. */}
                <button
                  type="button"
                  aria-label={`Start a chat on #${issue.number}`}
                  title="Start a chat on this issue"
                  disabled={starting !== null}
                  onClick={() => void startOn(issue.number)}
                  className="btn my-1 mr-1 shrink-0 px-1.5 py-0 text-xs disabled:opacity-50"
                >
                  {starting === issue.number ? 'Starting…' : 'Chat'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function IssueView({ app, owner, number, onBack }: { app: App; owner: string; number: number; onBack: () => void }): JSX.Element {
  // gh's last answer for the issue, shown while it's fetched again, and this view's half-written comment.
  const issue = useOtherBenchStore((s) => s.issueDetails[`${app.id}#${number}`] ?? null);
  const cacheIssue = useOtherBenchStore((s) => s.cacheIssue);
  const comment = useOtherBenchStore((s) => s.issueDrafts[`${owner}#${number}`] ?? '');
  const setIssueDraft = useOtherBenchStore((s) => s.setIssueDraft);
  const setComment = (text: string): void => setIssueDraft(`${owner}#${number}`, text);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<'comment' | 'state' | 'chat' | null>(null);
  const [actionError, setActionError] = useState<{ error: unknown; fallback: string } | null>(null);
  const needsYou = useNeedingIssues(app.id).has(number);
  const tick = useTickIssue(app.id);

  useCodeRefresh(app.id, () => setReload((n) => n + 1));
  useEffect(() => {
    let cancelled = false;
    api.apps.issues.get(app.id, number).then(
      (r) => {
        if (cancelled) return;
        cacheIssue(app.id, r);
        setLoadError(null);
      },
      (err: unknown) => !cancelled && setLoadError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [app.id, number, reload, cacheIssue]);

  /** One user action on the issue; the route answers 204, so the issue is fetched again after. */
  async function act(kind: 'comment' | 'state', run: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(kind);
    setActionError(null);
    try {
      await run();
      setReload((n) => n + 1);
      return true;
    } catch (err) {
      console.error(`[otherbench-web] issue #${number} ${kind} failed:`, err);
      setActionError({ error: err, fallback: kind === 'comment' ? "Couldn't post the comment." : "Couldn't change the issue." });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function postComment(): Promise<void> {
    const body = comment.trim();
    if (!body) return;
    if (await act('comment', () => api.apps.issues.comment(app.id, number, body))) setComment('');
  }

  async function startChat(): Promise<void> {
    if (!issue || busy) return;
    setBusy('chat');
    setActionError(null);
    try {
      await startChatFromIssue(app, issue);
    } catch (err) {
      console.error(`[otherbench-web] failed to start a chat on issue #${number}:`, err);
      setActionError({ error: err, fallback: "Couldn't start the chat. Please try again." });
    } finally {
      setBusy(null);
    }
  }

  const back = (
    <button type="button" onClick={onBack} aria-label="Back to issues" className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
      <span aria-hidden="true">← Issues</span>
    </button>
  );

  if (!issue) {
    return (
      <div className="space-y-2">
        {back}
        {loadError !== null ? <CodeErrorLine error={loadError} fallback="Couldn't load the issue." /> : <p className={EMPTY}>Loading…</p>}
      </div>
    );
  }

  const open = issue.state === 'open';
  return (
    <div data-testid="issue-detail" className="min-w-0 space-y-3">
      <div className="flex items-center gap-2">
        {back}
        <span className="flex-1" />
        <a
          href={issue.url}
          onClick={(e) => {
            e.preventDefault();
            void openInBrowser(issue.url);
          }}
          className="text-xs text-[var(--accent)] hover:underline"
        >
          Open on GitHub
        </a>
      </div>
      <div>
        <h3 className="text-sm font-medium [overflow-wrap:anywhere]">{`#${issue.number} ${issue.title}`}</h3>
        <p className={MUTED}>
          <span data-testid="issue-state">{open ? 'Open' : 'Closed'}</span>
          {` · ${issue.author}`}
          {when(issue.createdAt) && ` · ${when(issue.createdAt)}`}
        </p>
        {issue.labels.length > 0 && <p className={`mt-0.5 ${MUTED}`}>{issue.labels.join(', ')}</p>}
      </div>
      <div onClick={stayInApp} className="min-w-0 [overflow-wrap:anywhere]">
        {issue.body.trim() ? <MarkdownBody text={issue.body} /> : <p className={EMPTY}>No description provided.</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void startChat()} className="btn btn-primary px-2.5 py-1">
          Start a chat on this
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void act('state', () => (open ? api.apps.issues.close(app.id, number) : api.apps.issues.reopen(app.id, number)))}
          className="btn px-2.5 py-1"
        >
          {open ? 'Close issue' : 'Reopen issue'}
        </button>
        {needsYou && (
          <button type="button" onClick={() => void tick(number)} className="btn px-2.5 py-1">
            Tick off
          </button>
        )}
      </div>
      {actionError !== null && <CodeErrorLine error={actionError.error} fallback={actionError.fallback} />}
      <section aria-label="Comments" className="space-y-2 border-t border-[var(--border)] pt-2">
        <h4 className="label-caps text-[var(--text-muted)]">{issue.commentList.length === 1 ? '1 comment' : `${issue.commentList.length} comments`}</h4>
        {issue.commentList.length > 0 && (
          <ul className="space-y-2">
            {issue.commentList.map((c, i) => (
              <li key={i} className="rounded-sm border border-[var(--border)] p-2">
                <p className={`mb-1 ${MUTED}`}>
                  {c.author}
                  {when(c.createdAt) && ` · ${when(c.createdAt)}`}
                </p>
                <div onClick={stayInApp} className="min-w-0 [overflow-wrap:anywhere]">
                  <MarkdownBody text={c.body} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <textarea
          aria-label="Comment"
          placeholder="Leave a comment…"
          value={comment}
          readOnly={busy === 'comment'}
          rows={3}
          onChange={(e) => setComment(e.target.value)}
          className="w-full resize-y rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1.5 text-sm read-only:opacity-60 focus:border-[var(--accent)] focus:outline-none"
        />
        <button type="button" disabled={busy !== null || comment.trim() === ''} onClick={() => void postComment()} className="btn px-2.5 py-1">
          Comment
        </button>
      </section>
    </div>
  );
}
