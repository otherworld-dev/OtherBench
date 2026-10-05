import { useEffect, useState, type JSX } from 'react';
import type { NodeInfo } from '@grunt/core/types/workspace.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { isDesktop, pickFolder } from '../../desktop/bridge.js';
import { useServerPlatform, validateWorkspaceRoot } from '../../lib/workspaceRoot.js';
import { ApiError, api, type LocationView } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';

export const LOCATIONS_HELP =
  'A location is a folder you keep on more than one machine -- Nextcloud, say -- wherever each machine has it. A chat folder inside a location works on every machine that knows where the location is; each machine sets only its own path.';

const BUTTON = 'rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--bg-sunken)] disabled:opacity-50';
const PRIMARY = 'rounded bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-text)] disabled:opacity-50';
const INPUT = 'rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs';

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Save failed -- please try again.';
}

/** A path field with the desktop folder picker beside it. */
function PathInput({ value, onChange, label, onEnter }: { value: string; onChange: (v: string) => void; label: string; onEnter: () => void }): JSX.Element {
  const serverPlatform = useServerPlatform();
  return (
    <span className="flex flex-1 gap-2">
      <input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder={serverPlatform === 'win32' ? 'E:\\Nextcloud' : '/home/user/Nextcloud'}
        className={`${INPUT} min-w-40 flex-1 font-mono`}
      />
      {isDesktop() && (
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            pickFolder()
              .then((picked) => {
                if (picked !== null) onChange(picked);
              })
              .catch((err: unknown) => console.error('[grunt-web] folder picker failed:', err));
          }}
        >
          Choose…
        </button>
      )}
    </span>
  );
}

function LocationRow({
  location,
  self,
  onChanged,
  onDelete,
}: {
  location: LocationView;
  self: NodeInfo | null;
  onChanged: (next: LocationView) => void;
  onDelete: () => void;
}): JSX.Element {
  const serverPlatform = useServerPlatform();
  const here = location.paths.find((p) => p.nodeId === self?.id) ?? null;
  const elsewhere = location.paths.filter((p) => p.nodeId !== self?.id);
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(here?.path ?? '');
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(location.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<LocationView>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
      return true;
    } catch (err) {
      setError(failure(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function savePath(): Promise<void> {
    const problem = validateWorkspaceRoot(pathDraft, serverPlatform);
    if (problem) {
      setError(problem);
      return;
    }
    if (await run(() => api.locations.setPath(location.id, pathDraft.trim()))) setEditingPath(false);
  }

  async function saveName(): Promise<void> {
    if (await run(() => api.locations.rename(location.id, nameDraft))) setRenaming(false);
  }

  return (
    <li data-testid={`location-${location.id}`} className="space-y-2 rounded border border-[var(--border)] p-3">
      <div className="flex items-center justify-between gap-2">
        {renaming ? (
          <span className="flex gap-2">
            <input aria-label="Location name" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className={INPUT} />
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => void saveName()}>
              Save
            </button>
            <button type="button" className={BUTTON} onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="font-medium">{location.name}</span>
        )}
        <span className="flex gap-2">
          {!renaming && (
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                setNameDraft(location.name);
                setRenaming(true);
              }}
            >
              Rename
            </button>
          )}
          <button type="button" className={`${BUTTON} text-[var(--danger)]`} onClick={onDelete}>
            Delete
          </button>
        </span>
      </div>

      <div className="text-xs">
        <span className="text-[var(--text-muted)]">This machine: </span>
        {editingPath ? (
          <span className="mt-1 flex flex-wrap gap-2">
            <PathInput label={`${location.name} folder on this machine`} value={pathDraft} onChange={setPathDraft} onEnter={() => void savePath()} />
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => void savePath()}>
              Save
            </button>
            <button type="button" className={BUTTON} onClick={() => setEditingPath(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <>
            {here ? <span className="font-mono">{here.path}</span> : <span className="text-[var(--text-faint)]">not set here</span>}{' '}
            <button
              type="button"
              className="ml-1 underline"
              onClick={() => {
                setPathDraft(here?.path ?? '');
                setError(null);
                setEditingPath(true);
              }}
            >
              {here ? 'Change' : 'Set'}
            </button>
            {here && (
              <button type="button" className="ml-2 underline" disabled={busy} onClick={() => void run(() => api.locations.setPath(location.id, null))}>
                Remove
              </button>
            )}
          </>
        )}
      </div>

      {elsewhere.length > 0 && (
        <ul className="space-y-0.5 text-xs text-[var(--text-muted)]">
          {elsewhere.map((p) => (
            <li key={p.nodeId}>
              Another machine ({p.nodeId.slice(0, 8)}): <span className="font-mono">{p.path}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </li>
  );
}

/** Settings → Locations (v2 plan, Task 43). */
export function LocationsPanel(): JSX.Element {
  const setProjects = useGruntStore((s) => s.setProjects);
  // Another machine's locations, and its paths for them, arrive by sync.
  const syncRevision = useGruntStore((s) => s.syncRevision);
  const serverPlatform = useServerPlatform();
  const [locations, setLocations] = useState<LocationView[] | null>(null);
  const [self, setSelf] = useState<NodeInfo | null>(null);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<LocationView | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.locations.list(), api.node.get()])
      .then(([list, node]) => {
        if (cancelled) return;
        setLocations(list);
        setSelf(node);
      })
      .catch((err: unknown) => {
        console.error('[grunt-web] failed to load locations:', err);
        if (!cancelled) setError("Couldn't load the locations.");
      });
    return () => {
      cancelled = true;
    };
  }, [syncRevision]);

  /** A project's folder can be in a location too; its view changes with the location's paths. */
  function refreshProjects(): void {
    api.projects
      .list()
      .then(setProjects)
      .catch((err: unknown) => console.error('[grunt-web] failed to reload projects:', err));
  }

  function replace(next: LocationView): void {
    setLocations((prev) => (prev ?? []).map((l) => (l.id === next.id ? next : l)));
    refreshProjects();
  }

  async function add(): Promise<void> {
    if (name.trim().length === 0) {
      setError('Enter a name.');
      return;
    }
    if (path.trim().length > 0) {
      const problem = validateWorkspaceRoot(path, serverPlatform);
      if (problem) {
        setError(problem);
        return;
      }
    }
    setAdding(true);
    setError(null);
    try {
      const created = await api.locations.create({ name: name.trim(), path: path.trim() || null });
      setLocations((prev) => [...(prev ?? []), created].sort((a, b) => a.name.localeCompare(b.name)));
      setName('');
      setPath('');
    } catch (err) {
      setError(failure(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className="max-w-2xl space-y-4 text-sm">
      <h3 className="text-sm font-semibold">Locations</h3>
      <p className="text-[var(--text-muted)]">{LOCATIONS_HELP}</p>

      {locations === null ? (
        !error && <p className="text-[var(--text-faint)]">Loading…</p>
      ) : locations.length === 0 ? (
        <p className="text-[var(--text-faint)]">No locations yet.</p>
      ) : (
        <ul className="space-y-2">
          {locations.map((l) => (
            <LocationRow key={l.id} location={l} self={self} onChanged={replace} onDelete={() => setDeleting(l)} />
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded border border-dashed border-[var(--border)] p-3">
        <p className="text-xs font-medium">Add a location</p>
        <div className="flex flex-wrap gap-2">
          <input aria-label="New location name" placeholder="Nextcloud" value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT} w-36`} />
          <PathInput label="New location folder on this machine" value={path} onChange={setPath} onEnter={() => void add()} />
          <button type="button" className={PRIMARY} disabled={adding} onClick={() => void add()}>
            Add
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          message="Chats and projects with a folder in it keep everything else but lose the folder, on every machine."
          confirmLabel="Delete location"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api.locations.delete(deleting.id);
            setLocations((prev) => (prev ?? []).filter((l) => l.id !== deleting.id));
            setDeleting(null);
            refreshProjects();
          }}
        />
      )}
    </section>
  );
}
