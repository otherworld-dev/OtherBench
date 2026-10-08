import { useCallback, useEffect, useState, type JSX } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { formatRelativeTime } from '../../lib/relativeTime.js';
import { ApiError, api, type PairingView, type PeerView, type PeersOverview } from '../../state/api.js';

export const FIREWALL_NOTE =
  'The first time Grunt listens for other machines, Windows asks whether to allow it: allow it on Private networks only.';

const BUTTON = 'btn px-2 py-1';
const PRIMARY = 'btn btn-primary px-2.5 py-1';
const INPUT = 'rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs';
const REFRESH_MS = 3000;

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : 'That didn\'t work -- please try again.';
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Connected", "Unreachable since 14:02", or "Checking…". */
export function peerStatusText(peer: Pick<PeerView, 'status' | 'since'>): string {
  if (peer.status === 'reachable') return 'Connected';
  if (peer.status === 'unreachable') return `Unreachable since ${clock(peer.since)}`;
  return 'Checking…';
}

function PairingCode({ pairing, onCancel, now }: { pairing: PairingView; onCancel: () => void; now: number }): JSX.Element {
  const left = Math.max(0, Math.ceil((pairing.expiresAt - now) / 60_000));
  return (
    <div data-testid="pairing-code" className="space-y-2 rounded border border-[var(--accent)] p-3">
      <p className="text-xs text-[var(--text-muted)]">On the other machine, choose Add a machine and enter:</p>
      <p className="font-mono text-2xl tracking-widest">{pairing.code}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-[var(--text-muted)]">Address</dt>
        <dd className="font-mono">{pairing.addresses.length > 0 ? pairing.addresses.join(', ') : 'none found -- check this machine is on a network'}</dd>
        <dt className="text-[var(--text-muted)]">This machine</dt>
        <dd className="font-mono">{pairing.fingerprint}</dd>
      </dl>
      <p className="text-xs text-[var(--text-muted)]">
        The code works once, for {left} more minute{left === 1 ? '' : 's'}. {FIREWALL_NOTE}
      </p>
      <button type="button" className={BUTTON} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** "Synced 2 min ago", the last sync error, or "Not synced yet". */
export function syncText(peer: Pick<PeerView, 'lastSyncedAt' | 'syncError'>, now = Date.now()): string {
  if (peer.syncError) return `Sync failed: ${peer.syncError}`;
  if (peer.lastSyncedAt !== null) return `Synced ${formatRelativeTime(peer.lastSyncedAt, now)}`;
  return 'Not synced yet';
}

function PeerRow({ peer, onChanged, onRemove }: { peer: PeerView; onChanged: () => void; onRemove: () => void }): JSX.Element {
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(peer.name);
  const [addresses, setAddresses] = useState(peer.addresses.join(', '));
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setError(null);
    try {
      const list = addresses
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      await api.peers.patch(peer.nodeId, { name, addresses: list });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(failure(err));
    }
  }

  return (
    <li data-testid={`peer-${peer.nodeId}`} className="space-y-1 rounded border border-[var(--border)] p-3">
      {editing ? (
        <div className="space-y-2">
          <input aria-label="Machine name" value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT} w-48`} />
          <input aria-label="Addresses" value={addresses} onChange={(e) => setAddresses(e.target.value)} className={`${INPUT} w-full font-mono`} />
          <p className="text-xs text-[var(--text-muted)]">host:port, comma-separated, tried in order (the last one that worked goes first).</p>
          <span className="flex gap-2">
            <button type="button" className={PRIMARY} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className={BUTTON} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span>
            <span className="font-medium">{peer.name}</span>{' '}
            <span data-testid="peer-status" className={`text-xs ${peer.status === 'reachable' ? 'text-[var(--success)]' : peer.status === 'unreachable' ? 'text-[var(--warn)]' : 'text-[var(--text-faint)]'}`}>
              {peerStatusText(peer)}
            </span>
          </span>
          <span className="flex gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={syncing}
              onClick={() => {
                setSyncing(true);
                setError(null);
                api.peers
                  .sync(peer.nodeId)
                  .then(onChanged)
                  .catch((err: unknown) => setError(failure(err)))
                  .finally(() => setSyncing(false));
              }}
            >
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                setName(peer.name);
                setAddresses(peer.addresses.join(', '));
                setEditing(true);
              }}
            >
              Edit
            </button>
            <button type="button" className={`${BUTTON} btn-danger`} onClick={onRemove}>
              Remove
            </button>
          </span>
        </div>
      )}
      {!editing && <p className="font-mono text-xs text-[var(--text-muted)]">{peer.addresses.join(', ')}</p>}
      {!editing && (
        <p data-testid="peer-sync" className={`text-xs ${peer.syncError ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
          {syncText(peer)}
        </p>
      )}
      {!editing && peer.status === 'unreachable' && peer.error && <p className="text-xs text-[var(--text-faint)]">{peer.error}</p>}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </li>
  );
}

/** Settings → Machines (v2 plan, Task 47): pair this machine with another, and see and remove paired ones. */
export function MachinesPanel(): JSX.Element {
  const [overview, setOverview] = useState<PeersOverview | null>(null);
  const [pairing, setPairing] = useState<PairingView | null>(null);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [selfName, setSelfName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PeerView | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [next, open] = await Promise.all([api.peers.overview(), api.peers.currentPairing()]);
      setOverview(next);
      setPairing(open);
      setNow(Date.now());
    } catch (err) {
      console.error('[grunt-web] failed to load machines:', err);
      setError(failure(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function startPairing(): Promise<void> {
    setError(null);
    try {
      setPairing(await api.peers.startPairing());
      setNow(Date.now());
    } catch (err) {
      setError(failure(err));
    }
  }

  async function cancelPairing(): Promise<void> {
    await api.peers.cancelPairing().catch((err: unknown) => setError(failure(err)));
    setPairing(null);
  }

  async function add(): Promise<void> {
    if (address.trim().length === 0 || code.trim().length === 0) {
      setError('Enter the address and the code shown on the other machine.');
      return;
    }
    setAdding(true);
    setError(null);
    try {
      await api.peers.add(address.trim(), code.trim());
      setAddress('');
      setCode('');
      await refresh();
    } catch (err) {
      setError(failure(err));
    } finally {
      setAdding(false);
    }
  }

  async function renameSelf(): Promise<void> {
    try {
      await api.node.rename(selfName);
      setRenaming(false);
      await refresh();
    } catch (err) {
      setError(failure(err));
    }
  }

  return (
    <section className="max-w-2xl space-y-4 text-sm">
      <h3 className="text-sm font-semibold">Machines</h3>
      <p className="text-[var(--text-muted)]">
        Pair this machine with another running Grunt to share chats between them and run a chat on whichever machine has its folder.
      </p>

      {overview && (
        <div data-testid="this-machine" className="flex items-center gap-2 text-xs">
          <span className="text-[var(--text-muted)]">This machine:</span>
          {renaming ? (
            <>
              <input aria-label="This machine's name" value={selfName} onChange={(e) => setSelfName(e.target.value)} className={INPUT} />
              <button type="button" className={PRIMARY} onClick={() => void renameSelf()}>
                Save
              </button>
              <button type="button" className={BUTTON} onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="font-medium">{overview.self.name}</span>
              <span className="font-mono text-[var(--text-faint)]">{overview.self.fingerprint}</span>
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setSelfName(overview.self.name);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
            </>
          )}
        </div>
      )}

      {overview && overview.peers.length > 0 && (
        <ul className="space-y-2">
          {overview.peers.map((p) => (
            <PeerRow key={p.nodeId} peer={p} onChanged={() => void refresh()} onRemove={() => setRemoving(p)} />
          ))}
        </ul>
      )}
      {overview && overview.peers.length === 0 && <p className="text-[var(--text-faint)]">No paired machines yet.</p>}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-2 rounded border border-dashed border-[var(--border)] p-3">
          <p className="text-xs font-medium">Pair a machine</p>
          {pairing ? (
            <PairingCode pairing={pairing} now={now} onCancel={() => void cancelPairing()} />
          ) : (
            <>
              <p className="text-xs text-[var(--text-muted)]">Shows a one-time code to enter on the other machine.</p>
              <button type="button" className={PRIMARY} onClick={() => void startPairing()}>
                Show a code
              </button>
            </>
          )}
        </div>
        <div className="space-y-2 rounded border border-dashed border-[var(--border)] p-3">
          <p className="text-xs font-medium">Add a machine</p>
          <p className="text-xs text-[var(--text-muted)]">Enter the address and code shown on the other machine.</p>
          <input aria-label="Address" placeholder="192.168.1.20:4748" value={address} onChange={(e) => setAddress(e.target.value)} className={`${INPUT} w-full font-mono`} />
          <input
            aria-label="Code"
            placeholder="ABCD-EFGH"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add();
              }
            }}
            className={`${INPUT} w-full font-mono uppercase`}
          />
          <button type="button" className={PRIMARY} disabled={adding} onClick={() => void add()}>
            {adding ? 'Pairing…' : 'Add'}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message={`This machine stops sharing chats with ${removing.name} at once. ${removing.name} is told too if it can be reached; either way it can no longer connect.`}
          confirmLabel="Remove machine"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await api.peers.remove(removing.nodeId);
            setRemoving(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}
