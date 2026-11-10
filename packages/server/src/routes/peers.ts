import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { shortFingerprint } from '@otherbench/core/domain/pairing.js';
import type { Container } from '../container.js';
import type { PeerSchedules } from '@otherbench/core/types/peer.js';
import { peerFolderListingOf } from '../peer/location-dirs.js';
import { namedPeerSchedules } from '../peer/schedules.js';
import { PeerError, type PeerService } from '../peer/service.js';
import { requireNonEmptyString } from '../validation.js';
import { LOCATION_NAME_MAX } from './locations.js';

interface AddBody {
  address?: unknown;
  code?: unknown;
}

interface PatchBody {
  name?: unknown;
  addresses?: unknown;
}

function service(container: Container): PeerService {
  if (!container.peers) throw new HTTPException(503, { message: 'Pairing is not available on this server.' });
  return container.peers;
}

/** A pairing or peer failure as the HTTP error the UI shows. */
async function guarded<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof PeerError) throw new HTTPException(err.status, { message: err.message });
    throw err;
  }
}

function parseAddresses(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((a) => typeof a !== 'string' || a.trim().length === 0)) {
    throw new HTTPException(400, { message: '"addresses" must be a list of host:port strings.' });
  }
  return [...new Set((value as string[]).map((a) => a.trim()))];
}

/**
 * `/api/peers` (v2 plan, Task 47): this machine's side of pairing, for its
 * own UI. Settings → Machines shows a code here, or enters one shown on the
 * other machine, and lists and removes paired machines.
 */
export function peersRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const peers = service(container);
    const self = container.store.nodes.self();
    return c.json({
      self: { ...self, fingerprint: shortFingerprint(peers.fingerprint()) },
      listening: { running: peers.listener.running, addresses: peers.listener.addresses() },
      peers: peers.list().map((p) => {
        const sync = container.peers?.syncerOrNull()?.status(p.nodeId);
        return { ...p, ...peers.status(p.nodeId), lastSyncedAt: sync?.lastSyncedAt ?? null, syncError: sync?.error ?? null, versionMismatch: sync?.versionMismatch ?? null, activeChats: peers.activeChats(p.nodeId), backgroundChats: peers.backgroundChats(p.nodeId), waitingChats: peers.waitingChats(p.nodeId), waitingSince: peers.waitingSince(p.nodeId), computerSessions: peers.computerSessions(p.nodeId) };
      }),
    });
  });

  /**
   * Each paired machine's schedules, as it last said on its `/peer/events` stream, named from this machine's synced
   * rows: for the Schedules view, read-only. None while a machine isn't reachable, so its last list is never shown
   * stale. Nothing here, or on the peer listener, runs or changes a schedule on another machine.
   */
  app.get('/schedules', (c) => {
    const peers = service(container);
    const out: PeerSchedules[] = peers.list().map((p) => {
      const said = peers.schedules(p.nodeId);
      return { nodeId: p.nodeId, name: p.name, status: peers.status(p.nodeId).status, shared: said !== null, schedules: said ? namedPeerSchedules(container.store, said) : [] };
    });
    return c.json(out);
  });

  /**
   * A folder of a paired machine, for choosing a folder for a chat that runs there: asked there over the peer channel
   * (`GET /api/locations/dirs` on its listener), which lists sub-folders only inside its own locations and refuses
   * anything else (location-dirs.ts). No `path` lists its locations. What comes back is checked and bounded
   * (`peerFolderListingOf`) before it is passed on. A machine on a build without the route answers a bare 404, said
   * here as needing an update.
   */
  app.get('/:id/dirs', async (c) => {
    const peers = service(container);
    const nodeId = c.req.param('id');
    const peer = peers.peer(nodeId);
    if (!peer) throw new HTTPException(404, { message: `No paired machine "${nodeId}".` });
    const path = c.req.query('path');
    let res;
    try {
      res = await peers.call(nodeId, { method: 'GET', path: `/api/locations/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}` });
    } catch (err) {
      if (err instanceof PeerError && err.status === 503) return c.json({ error: err.message, kind: 'peer_unreachable', nodeId }, 503);
      throw err;
    }
    if (res.status === 200) {
      const listing = peerFolderListingOf(res.body);
      if (!listing) return c.json({ error: `${peer.name} sent a folder list that couldn't be read.`, kind: 'peer_bad_answer', nodeId }, 502);
      return c.json(listing);
    }
    const said = typeof res.body === 'object' && res.body !== null ? (res.body as { error?: unknown; kind?: unknown }) : null;
    if (res.status === 404 && said === null) return c.json({ error: `${peer.name} needs a newer OtherBench to browse its folders.`, kind: 'peer_outdated', nodeId }, 501);
    const status = res.status === 400 || res.status === 403 || res.status === 404 ? res.status : 502;
    const error = typeof said?.error === 'string' ? said.error.slice(0, 300) : `${peer.name} couldn't list that folder.`;
    return c.json({ error, ...(typeof said?.kind === 'string' ? { kind: said.kind.slice(0, 40) } : {}) }, status);
  });

  /** Shows a code (starting the peer listener) for the other machine to enter. */
  app.post('/pairing', async (c) => c.json(await guarded(() => service(container).startPairing()), 201));

  app.get('/pairing', (c) => c.json(service(container).currentPairing()));

  app.delete('/pairing', async (c) => {
    await service(container).cancelPairing();
    return c.body(null, 204);
  });

  /** Enters the code another machine is showing. */
  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as AddBody;
    const address = requireNonEmptyString(body.address, 'address');
    const code = requireNonEmptyString(body.code, 'code');
    return c.json(await guarded(() => service(container).pairWith(address, code)), 201);
  });

  app.patch('/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as PatchBody;
    const patch: { name?: string; addresses?: string[] } = {};
    if (body.name !== undefined) {
      const name = requireNonEmptyString(body.name, 'name').trim();
      if (name.length === 0 || name.length > LOCATION_NAME_MAX) throw new HTTPException(400, { message: `A machine's name must be 1-${LOCATION_NAME_MAX} characters.` });
      patch.name = name;
    }
    if (body.addresses !== undefined) patch.addresses = parseAddresses(body.addresses);
    return c.json(await guarded(() => service(container).rename(c.req.param('id'), patch)));
  });

  /** Syncs with the machine now. */
  app.post('/:id/sync', async (c) => {
    const peers = service(container);
    if (!peers.peer(c.req.param('id'))) throw new HTTPException(404, { message: `No paired machine "${c.req.param('id')}".` });
    return c.json({ applied: await guarded(() => peers.requireSyncer().pullFrom(c.req.param('id'))) });
  });

  /** Removes the machine here at once and tells it, if it can be reached. */
  app.delete('/:id', async (c) => c.json(await guarded(() => service(container).remove(c.req.param('id')))));

  return app;
}
