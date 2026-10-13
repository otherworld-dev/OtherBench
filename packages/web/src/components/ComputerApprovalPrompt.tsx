import { useState, type JSX } from 'react';
import type { ApprovalChoice } from '@grunt/core/ports/tool-provider.js';
import { actionSummary, describeApp, isHighRiskApp, typedTextForCard, windowTitleForCard } from '@grunt/core/domain/computer-apps.js';
import type { ApprovalPromptProps } from './ApprovalPrompt.js';
import { oneLine, revealHidden } from '../viewer/browser.js';

/**
 * The approval card for computer use (spec 2026-10-12-computer-use-design
 * section 7, as the security contract in the plan has it): one card per app.
 *
 * Everything shown is read from the described arguments the broker raised the
 * card with, and through core's helpers only:
 *   - the app's name and full path come from `describeApp(args.app)` (never
 *     `appName`, never the window title), each in a `<bdi>` so right-to-left
 *     letters in a path can't reorder what is around them; the path is shown
 *     whole and wraps;
 *   - the window title is the app's own words, so it gets its own labelled
 *     line and is in no headline, summary or button;
 *   - the summary is `actionSummary`, which never holds typed text; a `type`
 *     call's text is only in its own scrolling box (`typedTextForCard`);
 *   - `isHighRiskApp` decides the once-only case: then only Allow once and
 *     Deny (a chat or always answer would be refused by the broker anyway).
 * "Always allow" sends the key exactly as it came, as `{ app }` and nothing else.
 */
export function ComputerApprovalPrompt({ request, onResolve }: ApprovalPromptProps): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const args: Record<string, unknown> =
    typeof request.args === 'object' && request.args !== null && !Array.isArray(request.args) ? (request.args as Record<string, unknown>) : {};
  const app = describeApp(args['app']);
  // The key unchanged (describeApp hands back exactly the string it validated): what "Always allow" pins.
  const key = app !== null ? app.key : null;
  const name = app !== null ? oneLine(app.name) : '';
  const onceOnly = isHighRiskApp(request.args);
  const title = oneLine(windowTitleForCard(args['appTitle']));
  const typed = typedTextForCard(request.args);
  const summary = oneLine(actionSummary(request.args));

  async function choose(choice: ApprovalChoice): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onResolve(request.id, choice);
      // On success the card unmounts when the approval-resolved event lands (as the standard card).
    } catch (err) {
      console.error(`[grunt-web] failed to resolve approval ${request.id}:`, err);
      setPending(false);
      setError('Could not send that decision -- please try again.');
    }
  }

  return (
    <div
      role="alert"
      data-testid={`approval-prompt-${request.id}`}
      className="my-1 space-y-2 rounded-sm border border-l-[3px] border-[var(--warn)] bg-[var(--bg-raised)] px-3 py-2 text-sm"
    >
      <p data-testid="computer-headline" className="flex items-start gap-2">
        <span aria-hidden="true">{'\u{1F5B1}'}</span>
        {app !== null ? (
          <span>
            Let the model use{' '}
            <strong>
              <bdi>{name}</bdi>
            </strong>
            ?
          </span>
        ) : (
          <span>{"Grunt couldn't tell which app this action would use."}</span>
        )}
      </p>
      {app !== null && (
        <p data-testid="computer-app-path" className="font-mono text-xs break-all whitespace-pre-wrap text-[var(--text)]">
          <bdi>{revealHidden(app.path)}</bdi>
        </p>
      )}
      {app?.unusual === true && (
        <p data-testid="computer-app-unusual" className="text-xs text-[var(--warn)]">
          {"This path has characters outside the plain Latin alphabet, so it may look like another program's. Grunt asks every time for it."}
        </p>
      )}
      {title !== '' && (
        <p data-testid="computer-window-title" className="text-xs break-all text-[var(--text-muted)]">
          Window title (set by the app): <bdi>{title}</bdi>
        </p>
      )}
      <p data-testid="approval-summary" className="rounded-sm bg-[var(--bg-sunken)] px-2 py-1 font-mono text-xs break-all">
        {app !== null ? (
          <>
            Use <bdi>{name}</bdi>: <bdi>{summary}</bdi>
          </>
        ) : (
          <bdi>{summary}</bdi>
        )}
      </p>
      {typed !== null && (
        <div className="text-xs">
          <span className="text-[var(--text-muted)]">It will type:</span>
          <pre
            data-testid="computer-typed-text"
            className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-[var(--bg-sunken)] px-2 py-1 font-mono"
          >
            <bdi>{typed}</bdi>
          </pre>
        </div>
      )}
      {/* An unusual path is always once-only, and its warning above already says so: one such line, not two. */}
      {app !== null && onceOnly && !app.unusual && (
        <p data-testid="computer-high-risk" className="text-xs text-[var(--warn)]">
          Grunt asks every time here.{' '}
          {args['appShellView'] === true
            ? 'This is a file dialog or file view, where any file can be opened or run.'
            : "This app can run commands or change system settings, or Grunt couldn't fully identify it."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="approval-deny" disabled={pending} onClick={() => void choose({ choice: 'deny' })} className="btn btn-danger px-2 py-1">
          Deny
        </button>
        {key !== null && (
          <button type="button" data-testid="approval-once" disabled={pending} onClick={() => void choose({ choice: 'once' })} className="btn btn-primary px-2 py-1">
            Allow once
          </button>
        )}
        {key !== null && !onceOnly && (
          <>
            <button type="button" data-testid="approval-chat" disabled={pending} onClick={() => void choose({ choice: 'chat' })} className="btn px-2 py-1">
              Allow for this chat
            </button>
            <button
              type="button"
              data-testid="approval-always"
              disabled={pending}
              onClick={() => void choose({ choice: 'always', constraint: { app: key } })}
              className="btn px-2 py-1"
            >
              Always allow <bdi>{name}</bdi>
            </button>
          </>
        )}
      </div>
      {key !== null && !onceOnly && (
        <p className="text-xs text-[var(--text-muted)]">
          {'"Always allow"'} lets the model use <bdi>{name}</bdi> in any chat on this profile.
        </p>
      )}
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
