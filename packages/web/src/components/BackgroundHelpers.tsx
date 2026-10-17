import { useEffect, useState, type JSX } from 'react';
import type { ApprovalChoice } from '@otherbench/core/ports/tool-provider.js';
import type { BackgroundHelper } from '@otherbench/core/types/background.js';
import { ApiError, api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { formatDuration } from './SubagentCard.js';

/** What a background task's kind is called beside its name; a helper (`local_agent`) needs no word. */
const KIND_LABEL: Record<string, string> = { local_bash: 'command', monitor: 'monitor', local_workflow: 'workflow', mcp_task: 'tool' };

const EMPTY: never[] = [];

/**
 * The chat's background tasks, above the message box (spec
 * 2026-10-17-claude-background-helpers-design): each helper or background
 * command with how long it has run and what it did last, a Stop, and any
 * approval card it is waiting on. Hidden with nothing running.
 */
export function BackgroundHelpers({ chatId, onResolveApproval }: { chatId: string; onResolveApproval: (requestId: string, choice: ApprovalChoice) => Promise<void> }): JSX.Element | null {
  const helpers = useOtherBenchStore((s) => s.chatHelpers[chatId] ?? EMPTY);
  const approvals = useOtherBenchStore((s) => s.backgroundApprovals[chatId] ?? EMPTY);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (helpers.length === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [helpers.length]);
  if (helpers.length === 0 && approvals.length === 0) return null;
  const orphans = approvals.filter((r) => !helpers.some((h) => h.callId !== null && r.subagent?.callId === h.callId));
  return (
    <div data-testid="background-helpers" className="mx-4 mb-2 space-y-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1.5 text-xs">
      <div className="label-caps text-[0.6875rem] text-[var(--text-faint)]">Working in the background</div>
      {helpers.map((helper) => (
        <HelperRow
          key={helper.taskId}
          chatId={chatId}
          helper={helper}
          now={now}
          approvals={approvals.filter((r) => helper.callId !== null && r.subagent?.callId === helper.callId)}
          onResolveApproval={onResolveApproval}
        />
      ))}
      {orphans.map((request) => (
        <ApprovalPrompt key={request.id} request={request} onResolve={onResolveApproval} />
      ))}
    </div>
  );
}

function HelperRow({ chatId, helper, now, approvals, onResolveApproval }: { chatId: string; helper: BackgroundHelper; now: number; approvals: ReturnType<typeof useOtherBenchStore.getState>['backgroundApprovals'][string]; onResolveApproval: (requestId: string, choice: ApprovalChoice) => Promise<void> }): JSX.Element {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = KIND_LABEL[helper.kind];

  async function stop(): Promise<void> {
    setStopping(true);
    setError(null);
    try {
      await api.chats.stopHelper(chatId, helper.taskId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't stop it. Please try again.");
      setStopping(false);
    }
  }

  return (
    <div data-testid="background-helper" className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" aria-hidden="true" />
        <span className="font-medium text-[var(--text)]">{helper.label}</span>
        {kind && <span className="text-[var(--text-muted)]">{kind}</span>}
        <span className="font-mono text-[var(--text-faint)]">{formatDuration(now - helper.startedAt)}</span>
        {approvals.length > 0 ? (
          <span className="text-[var(--warn)]">needs your approval</span>
        ) : (
          helper.lastActivity && <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-faint)]">{helper.lastActivity}</span>
        )}
        <button type="button" onClick={() => void stop()} disabled={stopping} aria-label={`Stop ${helper.label}`} className="btn ml-auto px-2 py-0.5">
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[var(--danger)]">
          {error}
        </p>
      )}
      {approvals.map((request) => (
        <ApprovalPrompt key={request.id} request={request} onResolve={onResolveApproval} />
      ))}
    </div>
  );
}
