import { useState, type JSX } from 'react';
import type { AuditEntry, Chat } from '@otherbench/core/ports/store.js';
import { useLiveData } from '../lib/useLiveData.js';
import { useNow } from '../lib/useNow.js';
import { api } from '../state/api.js';
import { machineName } from '../state/machines.js';
import { useOtherBenchStore } from '../state/store.js';
import { useSectionSummary } from './InspectorSection.js';
import { EmptyState, ShowAllToggle } from './InspectorParts.js';
import { formatAuditTime, grantedByLabel } from './inspectorHelpers.js';
import { loadFailedText, peerToolStateChanged, useRunsElsewhere } from './inspectorToolState.js';

const AUDIT_COLLAPSED_COUNT = 5;
/** How often the audit trail's "Ns ago" times are redrawn; nothing is fetched. */
const AUDIT_CLOCK_MS = 10_000;

/** "Audit trail" -- every gated tool call in this chat: tool, how it was authorised, a short result summary (never raw output/content -- redaction happens server-side, see OtherBenchToolProvider), and duration. Newest first. */
export function AuditSection({ chat }: { chat: Chat }): JSX.Element {
  const chatId = chat.id;
  const remote = useRunsElsewhere(chat);
  // The trail of the machine the chat runs on: its calls there are audited there.
  const { data: entries, failed, error } = useLiveData(
    () => api.audit.list(chatId),
    [chatId, chat.runsOn],
    (e) => (e.type === 'audit-changed' && e.chatId === chatId) || peerToolStateChanged(e, chat, 'audit')
  );
  // "12s ago" keeps counting with no new entry to redraw it.
  const now = useNow(AUDIT_CLOCK_MS);
  // A call approved from a paired machine says which (the decision's machine, kept by the server).
  const machines = useOtherBenchStore((s) => s.machines);
  const [expanded, setExpanded] = useState(false);
  useSectionSummary(
    failed ? "couldn't load" : entries === null ? null : entries.length === 0 ? 'none' : `${entries.length} call${entries.length === 1 ? '' : 's'}`
  );

  if (failed) return <EmptyState>{loadFailedText(error, 'Couldn’t load the audit trail for this chat.', remote)}</EmptyState>;
  if (entries === null) return <EmptyState>Loading…</EmptyState>;
  if (entries.length === 0) return <EmptyState>No tool calls recorded in this chat yet.</EmptyState>;

  const sorted: AuditEntry[] = [...entries].sort((a, b) => b.createdAt - a.createdAt);

  const shown = expanded ? sorted : sorted.slice(0, AUDIT_COLLAPSED_COUNT);

  return (
    <>
      <ul data-testid="audit-trail" className="space-y-2">
        {shown.map((entry) => (
          <li key={entry.id} data-testid={`audit-${entry.id}`} className="text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{entry.toolName}</span>
              <span className="text-xs text-[var(--text-muted)]">{formatAuditTime(entry.createdAt, now)}</span>
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              {entry.resultSummary} · <span title={entry.grantedBy}>{grantedByLabel(entry.grantedBy)}</span>
              {entry.decidedOnNode && machines && entry.decidedOnNode !== machines.self.id ? (
                <span data-testid="audit-decided-on"> on {machineName(machines, entry.decidedOnNode)}</span>
              ) : null}{' '}
              · {entry.durationMs}ms
            </div>
          </li>
        ))}
      </ul>
      <ShowAllToggle total={sorted.length} limit={AUDIT_COLLAPSED_COUNT} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
    </>
  );
}
