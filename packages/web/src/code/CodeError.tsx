import type { JSX } from 'react';
import { ApiError, type CodeErrorCode } from '../state/api.js';

/**
 * The one line each Code tab failure shows, picked by the server's `code`
 * (spec 2026-10-20-code-tab-design, "Error states the panels must handle":
 * say what's missing and the command that fixes it). A code with no line
 * here (repo-not-found, gh-failed, git-failed, one this build doesn't know)
 * shows the server's own one-line message instead.
 */
const COPY: Partial<Record<CodeErrorCode, string>> = {
  'not-on-this-machine': "This app's folder isn't on this machine",
  'gh-missing': "gh isn't installed on this machine",
  'gh-signed-out': "gh isn't signed in. Run `gh auth login`",
  'no-github-repo': 'No GitHub repo set for this app',
};

export const NO_GITHUB_REPO = COPY['no-github-repo']!;

/** What a failure says: its line, and git's or gh's stderr as-is when it carried some (never recovered from, only shown). */
export function codeErrorText(err: unknown, fallback: string): { message: string; stderr: string | null } {
  if (!(err instanceof ApiError)) return { message: fallback, stderr: null };
  const copy = err.code !== undefined ? COPY[err.code as CodeErrorCode] : undefined;
  const stderr = (err.code === 'gh-failed' || err.code === 'git-failed') && err.stderr && err.stderr.trim() !== '' ? err.stderr : null;
  return { message: copy ?? err.message, stderr };
}

/** A failure as one alert line, with the stderr behind "Details" when there is one. */
export function CodeErrorLine({ error, fallback, testId }: { error: unknown; fallback: string; testId?: string }): JSX.Element {
  const { message, stderr } = codeErrorText(error, fallback);
  return (
    <div role="alert" data-testid={testId} className="text-sm text-[var(--danger)] [overflow-wrap:anywhere]">
      <p>{message}</p>
      {stderr !== null && (
        <details className="mt-1 text-xs text-[var(--text-muted)]">
          <summary className="cursor-pointer">Details</summary>
          <pre className="mt-1 whitespace-pre-wrap font-mono">{stderr}</pre>
        </details>
      )}
    </div>
  );
}
