import { useState, type JSX } from 'react';
import type { ApprovalChoice, ApprovalRequest } from '@grunt/core/ports/tool-provider.js';
import { classifyAgentTool } from '@grunt/core/domain/agent-tools.js';
import { normaliseHost } from '@grunt/core/domain/browser-hosts.js';
import { canonicalHost } from '@grunt/core/domain/network-hosts.js';
import { oneLine, revealHidden } from '../viewer/browser.js';
import { ComputerApprovalPrompt } from './ComputerApprovalPrompt.js';

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

/** A Claude Code shell-category tool (Bash, PowerShell, ...) -- grants are scoped like Grunt's own shell tool. */
function isAgentShell(request: ApprovalRequest): boolean {
  return request.source === 'agent' && classifyAgentTool(request.toolName).category === 'shell';
}

/**
 * A sandbox_network card's host and port (spec 2026-10-12-sandbox-design,
 * "Cards and audit"), or null for any other card. The host is shown, and
 * granted, in its canonical form (lower-case, punycode for an IDN): a
 * look-alike name must not read as pypi.org on the card, and the broker only
 * accepts a grant naming the card's own canonical host. A name with no
 * canonical form never reaches a card (the broker refuses it first); its raw
 * spelling is shown as-is.
 */
function networkTarget(request: ApprovalRequest): { host: string; port: number | null } | null {
  if (request.source !== 'network') return null;
  const args = request.args as Record<string, unknown> | null;
  const raw = args && typeof args['host'] === 'string' ? args['host'] : null;
  if (raw === null) return null;
  return { host: canonicalHost(raw) ?? raw, port: args && typeof args['port'] === 'number' ? args['port'] : null };
}

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
 *
 * Controller ruling (`.superpowers/sdd/2026-08-12-grunt-v1/progress.md`):
 * *"shell grants DEFAULT TO EXACT COMMAND. `commandPrefix` remains available
 * but must be an explicit opt-in with a visible warning, never the default
 * offered by the UI."* `allowAnyArgs` is that opt-in -- it is `false` unless
 * the human has explicitly checked the warned checkbox below, so the default
 * path through this function always produces `commandExact` for shell. A
 * `commandPrefix` grant matches the approved program with ANY trailing
 * arguments, which for most real programs is equivalent to arbitrary code
 * execution (see `commandPrefixMatches`'s doc in permissions.ts for concrete
 * examples) -- it must never be what a single click produces.
 */
function deriveAlwaysConstraint(
  request: ApprovalRequest,
  allowAnyArgs: boolean
): Extract<ApprovalChoice, { choice: 'always' }>['constraint'] {
  // A network grant is for one host, any port: "always reach anything" is never one click.
  const network = networkTarget(request);
  if (network) return { host: network.host };
  const args = request.args as Record<string, unknown> | null;
  // A browser grant is for the one site the card names (spec 2026-10-12-model-browser-design §6), by the same rule as
  // the network's: exactly `{ host }`, the card's own, in its canonical spelling. The broker refuses anything else.
  if (request.source === 'browser') {
    const site = args && typeof args['host'] === 'string' ? args['host'] : null;
    return site === null ? null : { host: normaliseHost(site) ?? site };
  }
  if ((request.source === 'shell' || request.source === 'sandbox' || isAgentShell(request)) && args && typeof args['command'] === 'string') {
    return allowAnyArgs ? { commandPrefix: args['command'] } : { commandExact: args['command'] };
  }
  if ((request.source === 'fs' || isAgentFileTool(request)) && args && typeof args['path'] === 'string') {
    return { pathPrefix: args['path'] };
  }
  return null;
}

/**
 * A Claude Code file tool, whose `path` the engine set to the workspace-relative
 * path it checked. Any other agent tool's `path` is just the tool's own
 * argument (an MCP tool's, say), not something a path grant should key on.
 */
function isAgentFileTool(request: ApprovalRequest): boolean {
  if (request.source !== 'agent') return false;
  const { category } = classifyAgentTool(request.toolName);
  return category === 'file-read' || category === 'file-write';
}

/** True when this request's args carry a shell `command` string -- the only case `deriveAlwaysConstraint` has a prefix/exact choice to make at all. */
function isShellCommandRequest(request: ApprovalRequest): boolean {
  const args = request.args as Record<string, unknown> | null;
  return (request.source === 'shell' || request.source === 'sandbox' || isAgentShell(request)) && !!args && typeof args['command'] === 'string';
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
function StandardApprovalPrompt({ request, onResolve }: ApprovalPromptProps): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Explicit, secondary opt-in for a `commandPrefix` "always" grant -- see
  // deriveAlwaysConstraint's doc for the ruling this defaults `false` to
  // satisfy. Only ever consulted for a shell request with a `command` arg;
  // meaningless (and hidden) otherwise.
  const [allowAnyArgs, setAllowAnyArgs] = useState(false);
  const isShellCommand = isShellCommandRequest(request);
  const network = networkTarget(request);
  // A browser card names the site (`args.host`, which the server takes from the page's committed address). Everything else
  // it shows from the page (`target`, the address in the summary) is untrusted text, so it is shown as plain, labelled lines.
  const browserArgs = request.source === 'browser' && request.args && typeof request.args === 'object' ? (request.args as Record<string, unknown>) : null;
  const browserHost = browserArgs && typeof browserArgs['host'] === 'string' ? browserArgs['host'] : null;
  const typedText = browserArgs && browserArgs['command'] === 'type' && typeof browserArgs['text'] === 'string' ? browserArgs['text'] : null;
  const browserTarget = browserArgs ? oneLine(browserArgs['target']) : '';
  const labels = network
    ? { once: 'Once', chat: 'This chat', always: 'Always' }
    : browserHost !== null
      ? { once: 'Allow once', chat: 'Allow for this chat (this site)', always: `Always allow ${browserHost}` }
      : { once: 'Allow once', chat: 'Allow for this chat', always: 'Always allow' };

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
      className="my-1 space-y-2 rounded-sm border border-l-[3px] border-[var(--warn)] bg-[var(--bg-raised)] px-3 py-2 text-sm"
    >
      {request.subagent && (
        <p data-testid="approval-subagent" className="text-xs text-[var(--text-muted)]">
          Sub-agent: {request.subagent.label}
          {request.subagent.profileName !== undefined && ` (runs as ${request.subagent.profileName})`}
        </p>
      )}
      <div className="flex items-center gap-2">
        <span aria-hidden="true">🔒</span>
        {network ? (
          <span data-testid="approval-network-question">
            Let the sandbox reach <strong>{network.host}</strong>
            {network.port !== null ? ` (port ${network.port})` : ''}?
          </span>
        ) : browserHost !== null ? (
          <span>
            Let the model use <strong>{browserHost}</strong>?
          </span>
        ) : (
          <span>
            Wants to run <strong>{request.toolName}</strong>
            {request.source === 'sandbox' ? ' in the sandbox' : ''}
            <span className="ml-1 text-xs text-[var(--text-muted)]">({RISK_LABEL[request.risk]})</span>
          </span>
        )}
      </div>
      {/* A network card's question already says it all. Every browser card's summary can carry the page's or the model's text (an address), whether or not a site was named. */}
      {!network && (
        <p data-testid="approval-summary" className="rounded-sm bg-[var(--bg-sunken)] px-2 py-1 font-mono text-xs break-all">
          {browserArgs !== null ? <bdi>{oneLine(request.summary)}</bdi> : request.summary}
        </p>
      )}
      {browserTarget !== '' && (
        <p data-testid="approval-browser-target" className="text-xs text-[var(--text-muted)] break-all">
          Element on the page: &ldquo;<bdi>{browserTarget}</bdi>&rdquo;
        </p>
      )}
      {typedText !== null && (
        <div className="text-xs">
          <span className="text-[var(--text-muted)]">It will type:</span>
          <pre data-testid="approval-typed-text" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-[var(--bg-sunken)] px-2 py-1 font-mono">
            {revealHidden(typedText)}
          </pre>
        </div>
      )}
      {isShellCommand && (
        <div className="space-y-1">
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <input
              type="checkbox"
              data-testid="approval-allow-any-args-toggle"
              checked={allowAnyArgs}
              onChange={(e) => setAllowAnyArgs(e.target.checked)}
            />
            Let &ldquo;Always allow&rdquo; permit this program with any arguments, instead of only this exact command
          </label>
          {allowAnyArgs && (
            <p data-testid="approval-any-args-warning" className="text-xs text-[var(--warn)]">
              Warning: this permits <strong>{(request.args as Record<string, unknown>)['command'] as string}</strong> to run with
              any arguments, for every future chat, with no further approval. For most programs that is equivalent to letting it
              run arbitrary code (e.g. via flags like <code>--node-options</code>, <code>-c core.pager=...</code>, or <code>-v /:/host</code>).
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="approval-deny"
          disabled={pending}
          onClick={() => void choose({ choice: 'deny' })}
          className="btn btn-danger px-2 py-1"
        >
          Deny
        </button>
        <button
          type="button"
          data-testid="approval-once"
          disabled={pending}
          onClick={() => void choose({ choice: 'once' })}
          className="btn btn-primary px-2 py-1"
        >
          {labels.once}
        </button>
        <button
          type="button"
          data-testid="approval-chat"
          disabled={pending}
          onClick={() => void choose({ choice: 'chat' })}
          className="btn px-2 py-1"
        >
          {labels.chat}
        </button>
        <button
          type="button"
          data-testid="approval-always"
          disabled={pending}
          onClick={() => void choose({ choice: 'always', constraint: deriveAlwaysConstraint(request, allowAnyArgs) })}
          className="btn px-2 py-1"
        >
          {labels.always}
        </button>
      </div>
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
    </div>
  );
}

/** One card per kind of request: computer use has its own (per app); everything else the standard one. A dispatcher, so no hook runs conditionally. */
export function ApprovalPrompt(props: ApprovalPromptProps): JSX.Element {
  if (props.request.source === 'computer') return <ComputerApprovalPrompt {...props} />;
  return <StandardApprovalPrompt {...props} />;
}
