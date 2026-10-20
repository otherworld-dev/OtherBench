import { useEffect, useState, type JSX, type MouseEvent } from 'react';
import type { App } from '@otherbench/core/ports/store.js';
import type { IssueDetail, IssueSummary } from '@otherbench/core/types/code.js';
import { MarkdownBody } from '../components/MarkdownBody.js';
import { openInBrowser } from '../desktop/bridge.js';
import { formatAge, formatRelativeTime } from '../lib/relativeTime.js';
import { api } from '../state/api.js';
import { CodeErrorLine, NO_GITHUB_REPO } from './CodeError.js';
import { startChatFromIssue } from './startChatFromIssue.js';

type IssueState = 'open' | 'closed';

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
 * An issue's body and comments come from GitHub as written, and Markdown can
 * hold a relative link (`../pull/5`). Outside a chat `MarkdownBody` leaves
 * such a link as a plain anchor, and following it would take the OtherBench
 * window itself away. Websites still open in the default browser through
 * `MarkdownBody`'s own handler (which runs first and prevents the default);
 * anything else is simply not followed.
 */
function stayInApp(e: MouseEvent<HTMLDivElement>): void {
  const link = e.target instanceof Element ? e.target.closest('a') : null;
  if (!link || e.defaultPrevented) return;
  const href = link.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(href) || href.startsWith('#') || /^mailto:/i.test(href)) return;
  e.preventDefault();
}

/**
 * The Code panel's Issues tab (spec 2026-10-20-code-tab-design, Goal 3): the
 * app's GitHub issues through the machine's own `gh`, newest first, open or
 * closed. A click shows one issue, where it can be commented on, closed or
 * reopened, or have a chat started on it (Goal 7). Each mutation answers 204,
 * so the issue is fetched again after it. Also the open-issues list on the
 * app home (`AppHome`), so the two always look and behave the same.
 */
export function IssuesTab({ app }: { app: App }): JSX.Element {
  const [state, setState] = useState<IssueState>('open');
  const [selected, setSelected] = useState<number | null>(null);
  // Another app's issues start from its list, not from the number this one had open.
  useEffect(() => setSelected(null), [app.id]);
  return (
    <div data-testid="issues-tab" className="min-w-0">
      {selected === null ? (
        <IssueList app={app} state={state} onState={setState} onOpen={setSelected} />
      ) : (
        <IssueView app={app} number={selected} onBack={() => setSelected(null)} />
      )}
    </div>
  );
}

function IssueList({ app, state, onState, onOpen }: { app: App; state: IssueState; onState: (s: IssueState) => void; onOpen: (n: number) => void }): JSX.Element {
  const [list, setList] = useState<{ repo: string; issues: IssueSummary[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const repo = app.githubRepo;

  useEffect(() => {
    setList(null);
    setError(null);
    // Nothing to ask gh about: the server would only answer no-github-repo.
    if (!repo) return;
    let cancelled = false;
    api.apps.issues.list(app.id, state).then(
      (r) => !cancelled && setList(r),
      (err: unknown) => !cancelled && setError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [app.id, repo, state, reload]);

  // gh lists newest first already; sorted here too so the order never depends on it.
  const issues = list ? [...list.issues].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number) : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className={`min-w-0 flex-1 truncate ${MUTED}`}>{list ? `${list.repo} · ${list.issues.length} ${state}` : (repo ?? '')}</p>
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
        <ul aria-label="Issues" className="space-y-0.5">
          {issues.map((issue) => (
            <li key={issue.number} data-issue={issue.number}>
              <button
                type="button"
                data-testid={`issue-row-${issue.number}`}
                onClick={() => onOpen(issue.number)}
                className="flex w-full min-w-0 items-start gap-2 rounded-sm px-1.5 py-1 text-left text-sm hover:bg-[var(--bg-sunken)]"
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
                <span className="shrink-0 text-xs text-[var(--text-faint)]">{age(issue.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueView({ app, number, onBack }: { app: App; number: number; onBack: () => void }): JSX.Element {
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'comment' | 'state' | 'chat' | null>(null);
  const [actionError, setActionError] = useState<{ error: unknown; fallback: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    api.apps.issues.get(app.id, number).then(
      (r) => !cancelled && setIssue(r),
      (err: unknown) => !cancelled && setLoadError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [app.id, number, reload]);

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
