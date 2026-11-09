import { useState, type JSX } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';
import type { McpServerHealth } from '@otherbench/tools/mcp/manager.js';
import { useChanged } from '../lib/useChanged.js';
import { useLiveData } from '../lib/useLiveData.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { useSectionSummary } from './InspectorSection.js';
import { EmptyState } from './InspectorParts.js';
import { mcpSummary } from './inspectorHelpers.js';
import { loadFailedText, peerToolStateChanged, useRunsElsewhere } from './inspectorToolState.js';

const MCP_STATUS_COLOR: Record<McpServerHealth['status'], string> = {
  ok: 'bg-[var(--success)]',
  connecting: 'bg-[var(--accent)] animate-pulse',
  error: 'bg-[var(--danger)]',
  unknown: 'bg-[var(--text-faint)]',
  needs_auth: 'bg-[var(--warn)]',
};

function StatusDot({ status }: { status: McpServerHealth['status'] }): JSX.Element {
  return <span data-testid="mcp-status-dot" data-status={status} className={`inline-block h-2 w-2 shrink-0 rounded-full ${MCP_STATUS_COLOR[status]}`} aria-hidden="true" />;
}

/**
 * "MCP servers" -- every configured server (enabled or not), its live
 * connection status, tool count, and a manual refresh action (`POST
 * /api/mcp-servers/:id/refresh`, task 25's reconnect-with-backoff still runs
 * on its own regardless). With the chat's profile loaded, each server also
 * gets a box for whether that profile may use it: its
 * `toolPolicy.mcpServerIds`, the same list as Settings > Profiles, so a
 * change applies to every chat on the profile. Servers it can't use are
 * dimmed, so a green dot doesn't read as "this chat has these tools".
 * With a chat, they are the servers of the machine it runs on: profiles sync
 * but servers don't, so ticking one of that machine's here is what lets the
 * chat use it there.
 */
export function McpServersSection({ chat, profile }: { chat: Chat | null; profile: Profile | null }): JSX.Element {
  const remote = useRunsElsewhere(chat);
  const { data: servers, failed, error } = useLiveData(
    () => api.mcpServers.list(chat?.id),
    [chat?.id, chat?.runsOn],
    (e) => e.type === 'mcp-changed' || (chat !== null && peerToolStateChanged(e, chat, 'mcp'))
  );
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const upsertProfile = useOtherBenchStore((s) => s.upsertProfile);
  const profileIds = profile?.toolPolicy.mcpServerIds ?? [];
  // The list as last saved from here, until the profile prop catches up.
  const [localIds, setLocalIds] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const profileKey = `${profile?.id ?? ''}:${profileIds.join(',')}`;
  if (useChanged([profileKey])) {
    setLocalIds(null);
    setSaveError(null);
  }
  const onIds = localIds ?? profileIds;
  const summary = mcpSummary(servers, failed, profile ? onIds : null);
  useSectionSummary(summary.text, summary.tone);

  async function toggleOn(id: string): Promise<void> {
    if (!profile) return;
    const before = onIds;
    const next = before.includes(id) ? before.filter((x) => x !== id) : [...before, id];
    setLocalIds(next);
    setSaving(true);
    setSaveError(null);
    try {
      upsertProfile(await api.profiles.patch(profile.id, { toolPolicy: { mcpServerIds: next } }));
    } catch (err) {
      setLocalIds(before);
      setSaveError(`Couldn't save the change to ${profile.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function refresh(id: string): Promise<void> {
    setRefreshingIds((s) => new Set(s).add(id));
    try {
      await api.mcpServers.refresh(id, chat?.id);
    } catch (err) {
      console.error(`[otherbench-web] failed to refresh MCP server ${id}:`, err);
    } finally {
      setRefreshingIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  if (failed) return <EmptyState>{loadFailedText(error, 'Couldn’t load MCP server health.', remote)}</EmptyState>;
  if (servers === null) return <EmptyState>Loading…</EmptyState>;
  if (servers.length === 0) return <EmptyState>{remote ? 'No MCP servers are configured there.' : 'No MCP servers are configured.'}</EmptyState>;

  return (
    <div data-testid="mcp-health" className="space-y-2">
      {profile && <p className="text-xs text-[var(--text-muted)]">Ticked servers are on for {profile.name}, in every chat that uses it.</p>}
      {servers.map((s) => {
        const dim = profile !== null && !onIds.includes(s.id) ? 'opacity-50' : '';
        return (
          <div key={s.id} data-testid={`mcp-server-${s.id}`} className="flex items-center gap-2 text-sm">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              {profile && (
                <input
                  type="checkbox"
                  aria-label={`Use ${s.name} in ${profile.name}`}
                  checked={onIds.includes(s.id)}
                  disabled={saving}
                  onChange={() => void toggleOn(s.id)}
                />
              )}
              <span className={`flex min-w-0 flex-1 items-center gap-2 ${dim}`}>
                <StatusDot status={s.status} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
              </span>
            </label>
            <span className={`text-xs text-[var(--text-muted)] ${dim}`}>{!s.enabled ? 'disabled' : s.status === 'needs_auth' ? 'needs sign-in' : `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}`}</span>
            <button
              type="button"
              aria-label={`Refresh ${s.name}`}
              disabled={refreshingIds.has(s.id)}
              onClick={() => void refresh(s.id)}
              className="rounded-sm border border-[var(--border-strong)] px-1.5 py-0.5 text-xs hover:bg-[var(--bg-sunken)] disabled:opacity-50"
            >
              ↻
            </button>
          </div>
        );
      })}
      {saveError && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {saveError}
        </p>
      )}
      {servers.some((s) => s.status === 'error' && s.lastError) && (
        <div className="space-y-1 pt-1">
          {servers
            .filter((s) => s.status === 'error' && s.lastError)
            .map((s) => (
              <p key={s.id} className="text-xs text-[var(--danger)]">
                {s.name}: {s.lastError}
              </p>
            ))}
        </div>
      )}
      {servers.some((s) => s.status === 'needs_auth') && (
        <div className="space-y-1 pt-1">
          {servers
            .filter((s) => s.status === 'needs_auth')
            .map((s) => (
              <p key={s.id} className="text-xs text-[var(--warn)]">
                {remote ? `${s.name}: needs sign-in (Settings > MCP servers, on that machine).` : `${s.name}: needs sign-in (Settings > MCP servers).`}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
