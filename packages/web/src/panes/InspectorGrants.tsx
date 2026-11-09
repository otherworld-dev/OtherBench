import { useState, type JSX } from 'react';
import { pathForCard } from '@otherbench/core/domain/computer-apps.js';
import type { Chat, Grant } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { useChanged } from '../lib/useChanged.js';
import { useLiveData } from '../lib/useLiveData.js';
import { api } from '../state/api.js';
import { useSectionSummary } from './InspectorSection.js';
import { EmptyState } from './InspectorParts.js';
import { loadFailedText, peerToolStateChanged, useRunsElsewhere } from './inspectorToolState.js';

/**
 * "Tool grants" -- every grant currently in effect for this chat (chat-scoped + global 'always' grants, see
 * routes/tools.ts), each with a Revoke action that takes effect on the VERY NEXT tool call (no restart -- see
 * PermissionBroker.decide, which reads the grant list fresh every time). Which 'always' grants apply depends on the
 * chat's profile, so a profile change reads the list again. They are the grants of the machine the chat runs on.
 */
export function GrantsSection({ chat }: { chat: Chat }): JSX.Element {
  const chatId = chat.id;
  const remote = useRunsElsewhere(chat);
  const { data: grants, failed, error } = useLiveData(
    () => api.grants.list(chatId),
    [chatId, chat.profileId, chat.runsOn],
    (e) => (e.type === 'grants-changed' && (e.chatId === null || e.chatId === chatId)) || peerToolStateChanged(e, chat, 'grants')
  );
  const [revoking, setRevoking] = useState<Set<string>>(new Set());
  const [localGrants, setLocalGrants] = useState<Grant[] | null>(null);

  // A fresh read (or another chat) replaces the optimistic list.
  if (useChanged([chatId, grants])) setLocalGrants(null);
  const shown = localGrants ?? grants;
  useSectionSummary(failed ? "couldn't load" : shown === null ? null : shown.length === 0 ? 'none' : `${shown.length} active`);

  async function revoke(id: string): Promise<void> {
    setRevoking((s) => new Set(s).add(id));
    try {
      await api.grants.revoke(id, chatId);
      // Optimistic removal -- the `grants-changed` the revoke announces
      // re-reads the list too, but only after a round trip and the
      // debounce, and decision #3 requires this to be verifiably
      // immediate, not eventually-consistent-looking.
      setLocalGrants((shown ?? []).filter((g) => g.id !== id));
    } catch (err) {
      console.error(`[otherbench-web] failed to revoke grant ${id}:`, err);
    } finally {
      setRevoking((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  if (failed) return <EmptyState>{loadFailedText(error, 'Couldn’t load grants for this chat.', remote)}</EmptyState>;
  if (shown === null) return <EmptyState>Loading…</EmptyState>;
  if (shown.length === 0) return <EmptyState>No grants issued in this chat yet.</EmptyState>;

  return (
    <div data-testid="grants-list" className="space-y-2">
      {shown.map((g) => (
        <div key={g.id} data-testid={`grant-${g.id}`} className="flex items-center gap-2 text-sm">
          {/* A computer grant's app is shown whole (it wraps), so two grants for different programs can be told apart. */}
          <span className={`min-w-0 flex-1 ${g.constraint?.app ? 'break-all' : 'truncate'}`}>
            <span className="font-medium">{g.toolName}</span>
            <span className="ml-1.5 text-xs text-[var(--text-muted)]">
              {g.scope === 'always' ? 'always' : 'this chat'}
              {g.constraint?.pathPrefix ? ` · ${g.constraint.pathPrefix}` : ''}
              {g.constraint?.host ? ` · ${g.constraint.host}` : ''}
              {g.constraint?.commandExact ? ` · ${g.constraint.commandExact}` : ''}
              {g.constraint?.commandPrefix ? ` · ${g.constraint.commandPrefix} (any arguments)` : ''}
              {g.constraint?.live ? ` · live artifact call ${g.constraint.live.callId}` : ''}
              {g.constraint?.app ? (
                <>
                  {' · '}
                  <bdi>{pathForCard(g.constraint.app)}</bdi>
                </>
              ) : null}
            </span>
          </span>
          <button
            type="button"
            aria-label={`Revoke grant for ${g.toolName}`}
            disabled={revoking.has(g.id)}
            onClick={() => void revoke(g.id)}
            className="btn btn-danger px-1.5 py-0.5"
          >
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The chat's profile's browser site list, above its grants: a standing grant the broker consults for every browser
 * call (PermissionBroker.decide), so someone checking what the browser may do without asking sees it here. Shown only
 * while the profile has the browser on and the list holds something. It is changed in the profile, as it applies to
 * every chat on it. Profiles sync, so unlike the grants below it is the same on every paired machine.
 */
export function ProfileSiteList({ profile }: { profile: Profile | null }): JSX.Element | null {
  const sites = profile?.browserAllowedSites ?? [];
  if (profile?.toolPolicy.browser !== true || sites.length === 0) return null;
  return (
    <div data-testid="profile-site-list" className="mb-2 text-xs">
      <p className="text-[var(--text-muted)]">
        The profile&rsquo;s site list also applies: the browser uses {sites.length === 1 ? 'this site' : 'these sites'} without asking, scheduled runs
        included. Change it in the profile.
      </p>
      <p className="mt-1 break-all font-mono">{sites.join(', ')}</p>
    </div>
  );
}
