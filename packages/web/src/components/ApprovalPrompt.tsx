import { useState, type JSX } from 'react';
import type { ApprovalChoice, ApprovalRequest } from '@grunt/core/ports/tool-provider.js';

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  /** Resolves once the server has accepted the choice (task 26: `POST /api/approvals/:id/resolve`). Rejecting re-enables the buttons so the user can retry rather than being left stuck. */
  onResolve: (requestId: string, choice: ApprovalChoice) => Promise<void>;
}

const RISK_LABEL: Record<ApprovalRequest['risk'], string> = {
  read: 'read',
  mutate: 'modifies something',
  execute: 'executes a command',
};

/**
 * Derives the constraint an "Always allow" grant is created with, from the
 * request's own args -- so the UI never needs a free-text constraint editor
 * for the common case. `path`/`command` are exactly the two fields
 * `PermissionBroker`'s `grantConstraintMatches` (packages/core/src/domain/
 * permissions.ts) knows how to match against; anything else (an MCP tool
 * with neither) gets an unconstrained grant, which the broker only refuses
 * for `source: 'shell'` -- see `PermissionBroker.resolve`'s own guard, which
 * this function's shell case exists specifically to satisfy rather than let
 * the request throw server-side.
 */
function deriveAlwaysConstraint(request: ApprovalRequest): Extract<ApprovalChoice, { choice: 'always' }>['constraint'] {
  const args = request.args as Record<string, unknown> | null;
  if (request.source === 'shell' && args && typeof args['command'] === 'string') {
    return { commandPrefix: args['command'] };
  }
  if (request.source === 'fs' && args && typeof args['path'] === 'string') {
    return { pathPrefix: args['path'] };
  }
  return null;
}

/**
 * Renders inline, directly under the message whose tool call is waiting on
 * it -- both in the thread (Message.tsx/Thread.tsx) and, identically, in the
 * Inspector's audit-adjacent view, since it's the same `ApprovalRequest`
 * either place reads off `MessageExtras.pendingApprovals`. A denial and
 * every approval scope map onto exactly the four choices
 * `PermissionBroker.resolve` accepts (packages/core/src/domain/
 * permissions.ts) -- no fifth option exists to invent here.
 */
export function ApprovalPrompt({ request, onResolve }: ApprovalPromptProps): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(choice: ApprovalChoice): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onResolve(request.id, choice);
      // On success this component is expected to unmount shortly (the
      // approval-resolved event removes it from pendingApprovals) -- no
      // need to reset `pending` here, and doing so risks a flash of
      // re-enabled buttons before that removal lands.
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
      className="my-1 space-y-2 rounded border border-[var(--warning,#b58900)] bg-[var(--bg-sunken)] px-3 py-2 text-sm"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true">🔒</span>
        <span>
          Wants to run <strong>{request.toolName}</strong>
          <span className="ml-1 text-xs text-[var(--text-muted)]">({RISK_LABEL[request.risk]})</span>
        </span>
      </div>
      <p className="text-xs text-[var(--text-muted)]">{request.summary}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="approval-deny"
          disabled={pending}
          onClick={() => void choose({ choice: 'deny' })}
          className="rounded border border-[var(--danger)] px-2 py-1 text-xs text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          data-testid="approval-once"
          disabled={pending}
          onClick={() => void choose({ choice: 'once' })}
          className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-raised)] disabled:opacity-50"
        >
          Allow once
        </button>
        <button
          type="button"
          data-testid="approval-chat"
          disabled={pending}
          onClick={() => void choose({ choice: 'chat' })}
          className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-raised)] disabled:opacity-50"
        >
          Allow for this chat
        </button>
        <button
          type="button"
          data-testid="approval-always"
          disabled={pending}
          onClick={() => void choose({ choice: 'always', constraint: deriveAlwaysConstraint(request) })}
          className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-raised)] disabled:opacity-50"
        >
          Always allow
        </button>
      </div>
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}
