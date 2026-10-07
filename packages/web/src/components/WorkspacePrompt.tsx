import { useEffect, useState, type JSX } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import type { WorkspaceStatus } from '@grunt/core/types/workspace.js';
import { isDesktop, pickFolder } from '../desktop/bridge.js';
import { useServerPlatform, validateWorkspaceRoot } from '../lib/workspaceRoot.js';
import { ApiError, api, type InferLocationResult, type LocationView } from '../state/api.js';
import { isReachablePeer, machineName } from '../state/machines.js';
import { useGruntStore } from '../state/store.js';

type Unresolved = Extract<WorkspaceStatus, { status: 'unresolved' }>;

const BUTTON = 'btn px-2.5 py-1';
const PRIMARY = 'btn btn-primary px-2.5 py-1';

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : 'That didn\'t work -- please try again.';
}

/** The question the prompt asks, per reason (v2 spec §6). */
export function workspacePromptTitle(status: Unresolved, locationName: string | null): string {
  switch (status.reason) {
    case 'no-location-path':
      return `Where is ${locationName ?? 'this location'} on this machine?`;
    case 'other-machine':
      return "This chat's folder is on another machine";
    case 'missing':
      return "This chat's folder isn't here any more";
  }
}

/**
 * Shown above the composer when the open chat's folder doesn't resolve on
 * this machine (v2 plan, Task 44). Sending is blocked until a choice is
 * made: say where the folder (or its location) is here, or carry on without
 * a folder. Choosing a folder for another machine's chat can turn the pair
 * into a location, which moves every chat from that machine under the same
 * root along with it.
 */
export function WorkspacePrompt({ chat }: { chat: Chat }): JSX.Element | null {
  const status = chat.workspaceStatus;
  // Nothing (not even the platform fetch) for the usual chat whose folder resolves.
  return status?.status === 'unresolved' ? <UnresolvedPrompt chat={chat} unresolved={status} /> : null;
}

function UnresolvedPrompt({ chat, unresolved }: { chat: Chat; unresolved: Unresolved }): JSX.Element {
  const upsertChat = useGruntStore((s) => s.upsertChat);
  const machines = useGruntStore((s) => s.machines);
  // The folder is where it should be on another machine that's reachable: the chat can run there.
  const runOn = unresolved.hint && unresolved.hint.nodeId !== chat.runsOn && isReachablePeer(machines, unresolved.hint.nodeId) ? unresolved.hint.nodeId : null;
  const serverPlatform = useServerPlatform();
  const locationId = chat.workspace?.kind === 'location' ? chat.workspace.locationId : null;

  const [locations, setLocations] = useState<LocationView[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inference, setInference] = useState<(InferLocationResult & { chosen: string }) | null>(null);
  const [locationName, setLocationName] = useState('');

  useEffect(() => {
    setDraft('');
    setError(null);
    setInference(null);
  }, [chat.id, unresolved.reason]);

  useEffect(() => {
    let cancelled = false;
    api.locations
      .list()
      .then((list) => {
        if (!cancelled) setLocations(list);
      })
      .catch((err: unknown) => console.error('[grunt-web] failed to load locations:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const location = locations.find((l) => l.id === locationId) ?? null;

  async function refreshChat(): Promise<void> {
    upsertChat(await api.chats.get(chat.id));
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  function checkedDraft(): string | null {
    const problem = validateWorkspaceRoot(draft, serverPlatform);
    if (problem) {
      setError(problem);
      return null;
    }
    return draft.trim();
  }

  function chooseFolder(): void {
    const path = checkedDraft();
    if (path === null) return;
    void run(async () => {
      if (unresolved.reason === 'no-location-path' && locationId) {
        await api.locations.setPath(locationId, path);
        await refreshChat();
        return;
      }
      if (unresolved.reason === 'other-machine' && unresolved.hint) {
        const inferred = await api.locations.infer({ nodeId: unresolved.hint.nodeId, fromPath: unresolved.hint.path, toPath: path });
        if (inferred.mapping) {
          setInference({ ...inferred, chosen: path });
          setLocationName(inferred.existing?.name ?? inferred.mapping.name);
          return;
        }
      }
      upsertChat(await api.chats.patch(chat.id, { workspacePath: path }));
    });
  }

  function adopt(): void {
    if (!inference?.mapping || !unresolved.hint) return;
    const { mapping, existing } = inference;
    const hint = unresolved.hint;
    void run(async () => {
      await api.locations.adopt({
        ...(existing ? { locationId: existing.id } : { name: locationName.trim() || mapping.name }),
        nodeId: hint.nodeId,
        fromRoot: mapping.fromRoot,
        toRoot: mapping.toRoot,
      });
      await refreshChat();
      setInference(null);
    });
  }

  function justThisChat(): void {
    if (!inference) return;
    const path = inference.chosen;
    void run(async () => {
      upsertChat(await api.chats.patch(chat.id, { workspacePath: path }));
      setInference(null);
    });
  }

  function runThere(): void {
    if (!runOn) return;
    void run(async () => {
      upsertChat(await api.chats.patch(chat.id, { runsOn: runOn }));
    });
  }

  function withoutFolder(): void {
    void run(async () => {
      upsertChat(await api.chats.patch(chat.id, { workspace: null }));
    });
  }

  const subpath = chat.workspace?.kind === 'location' ? chat.workspace.subpath : '';
  const explanation =
    unresolved.reason === 'no-location-path'
      ? `This chat's folder is ${subpath ? `"${subpath}" in ` : ''}${location?.name ?? 'a location'}, which has no folder on this machine yet.${unresolved.hint ? ` On another machine it's ${unresolved.hint.path}.` : ''}`
      : unresolved.reason === 'other-machine'
        ? `${unresolved.hint?.path ?? 'Its folder'} is on another machine. Choose where the same folder is here.`
        : `${unresolved.hint?.path ?? 'Its folder'} doesn't exist on this machine. Choose where it is now.`;

  return (
    <div data-testid="workspace-prompt" role="region" aria-label="Chat folder" className="mx-4 mb-2 space-y-2 rounded border border-[var(--warn)] bg-[var(--bg-raised)] p-3 text-sm">
      <p className="font-medium">{workspacePromptTitle(unresolved, location?.name ?? null)}</p>
      <p className="text-xs text-[var(--text-muted)]">{explanation}</p>

      {inference?.mapping ? (
        <div data-testid="workspace-prompt-location" className="space-y-2">
          <p className="text-xs">
            {inference.existing
              ? `That's in ${inference.existing.name}: ${inference.mapping.fromRoot} there is ${inference.mapping.toRoot} here.`
              : `Make a location? ${inference.mapping.fromRoot} there is ${inference.mapping.toRoot} here.`}{' '}
            {inference.affected > 1 ? `${inference.affected} chats and projects from that machine will use it.` : ''}
          </p>
          {!inference.existing && (
            <label className="flex items-center gap-2 text-xs">
              Name
              <input
                aria-label="Location name"
                value={locationName}
                onChange={(e) => setLocationName(e.target.value)}
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1"
              />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={adopt} disabled={busy} className={PRIMARY}>
              {inference.existing ? `Use ${inference.existing.name}` : 'Create location'}
            </button>
            <button type="button" onClick={justThisChat} disabled={busy} className={BUTTON}>
              Just this chat
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label={unresolved.reason === 'no-location-path' ? 'Location folder on this machine' : 'Folder on this machine'}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                chooseFolder();
              }
            }}
            placeholder={serverPlatform === 'win32' ? 'E:\\Nextcloud' : '/home/user/Nextcloud'}
            className="min-w-48 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-xs"
          />
          {isDesktop() && (
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                pickFolder()
                  .then((picked) => {
                    if (picked !== null) setDraft(picked);
                  })
                  .catch((err: unknown) => setError(`Couldn't open the folder picker: ${err instanceof Error ? err.message : String(err)}`));
              }}
            >
              Choose folder…
            </button>
          )}
          <button type="button" onClick={chooseFolder} disabled={busy || draft.trim().length === 0} className={PRIMARY}>
            {unresolved.reason === 'no-location-path' ? 'Save' : 'Use this folder'}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {runOn && (
          <button type="button" onClick={runThere} disabled={busy} className={BUTTON}>
            Run on {machineName(machines, runOn)}
          </button>
        )}
        <button type="button" onClick={withoutFolder} disabled={busy} className="text-xs text-[var(--text-muted)] underline hover:text-[var(--text)] disabled:opacity-50">
          Continue without a folder
        </button>
      </div>
      {error && (
        <p role="alert" data-testid="workspace-prompt-error" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
