import type { JSX } from 'react';
import { ApiError, type CodeErrorCode } from '../state/api.js';

/**
 * The one line each Code tab failure shows, picked by the server's `code`
 * (spec 2026-10-20-code-tab-design, "Error states the panels must handle":
 * say what's missing and the command that fixes it). A code with no line
 * here (repo-not-found, gh-failed, git-failed, nextcloud-app-missing, whose
 * server line names the app, one this build doesn't know) shows the server's
 * own one-line message instead. The git bar's three
 * states (not a repo, folder elsewhere, no git) come from here too, so the
 * bar and the panels say them the same way.
 */
const COPY: Partial<Record<CodeErrorCode, string>> = {
  'not-on-this-machine': "This app's folder isn't on this machine",
  'not-a-repo': 'Not a git repository',
  'git-missing': "git isn't installed on this machine",
  'gh-missing': "gh isn't installed on this machine",
  'gh-signed-out': "gh isn't signed in. Run `gh auth login`",
  'no-github-repo': 'No GitHub repo set for this app',
  'nextcloud-not-configured': "Nextcloud isn't set up on this machine. Add it in Settings → Nextcloud",
  'nextcloud-auth': 'Nextcloud refused the user name or app password. Check them in Settings → Nextcloud',
  'no-deck-board': 'No Deck board set for this app',
  'no-wiki-page': 'No Collectives page set for this app',
  'no-bookmark-tag': 'No bookmark tag set for this app',
};

export const NO_GITHUB_REPO = COPY['no-github-repo']!;
export const NO_DECK_BOARD = COPY['no-deck-board']!;
export const NO_WIKI_PAGE = COPY['no-wiki-page']!;
export const NO_BOOKMARK_TAG = COPY['no-bookmark-tag']!;

/** What a failure says: its line, and git's or gh's stderr as-is when it carried some (never recovered from, only shown). */
export function codeErrorText(err: unknown, fallback: string): { message: string; stderr: string | null } {
  if (!(err instanceof ApiError)) return { message: fallback, stderr: null };
  const copy = err.code !== undefined ? COPY[err.code as CodeErrorCode] : undefined;
  const stderr = (err.code === 'gh-failed' || err.code === 'git-failed') && err.stderr && err.stderr.trim() !== '' ? err.stderr : null;
  return { message: copy ?? err.message, stderr };
}

/**
 * A failure as one alert line, with the stderr when there is one. gh's sits
 * behind "Details". git's is shown open, as-is: a rejected push or a pull that
 * hit a conflict is only explained by what git said, and the panel never
 * tries to recover from it (spec 2026-10-20-code-tab-design, "Error states").
 */
export function CodeErrorLine({ error, fallback, testId }: { error: unknown; fallback: string; testId?: string }): JSX.Element {
  const { message, stderr } = codeErrorText(error, fallback);
  const gitFailed = error instanceof ApiError && error.code === 'git-failed';
  return (
    <div role="alert" data-testid={testId} className="text-sm text-[var(--danger)] [overflow-wrap:anywhere]">
      <p>{message}</p>
      {stderr !== null && gitFailed && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-[var(--text-muted)]">{stderr}</pre>
      )}
      {stderr !== null && !gitFailed && (
        <details className="mt-1 text-xs text-[var(--text-muted)]">
          <summary className="cursor-pointer">Details</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono">{stderr}</pre>
        </details>
      )}
    </div>
  );
}
