import type { IncomingMessage } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { fingerprintOf } from '@grunt/core/domain/pairing.js';
import type { Peer } from '@grunt/core/types/peer.js';
import { sseStream } from '../stream/sse.js';
import { PeerError, type PairRequest, type PeerService } from './service.js';

/** How often an idle `/peer/events` stream sends a comment, so neither side takes it for dead. */
export const PEER_EVENTS_KEEPALIVE_MS = 25_000;

export interface PeerEnv {
  Bindings: { incoming: IncomingMessage };
  Variables: { peer: Peer };
}

/** The certificate the caller presented on this TLS connection, as a fingerprint. */
export function callerFingerprint(c: Context<PeerEnv>): string | null {
  const socket = c.env?.incoming?.socket as TLSSocket | undefined;
  const raw = socket?.getPeerCertificate?.()?.raw as Buffer | undefined;
  return raw && raw.length > 0 ? fingerprintOf(raw) : null;
}

function bearer(c: Context<PeerEnv>): string | null {
  const header = c.req.header('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * What the peer listener serves (v2 plan, Task 46). Pairing is the one route
 * a stranger can call; everything else needs a paired machine's pinned
 * certificate AND the token we issued it. Nothing desktop-only is mounted
 * here -- in particular not attaching a file by local path, and not the
 * folder browser (v2 spec §8) -- and nothing is mounted by default: an
 * unknown path is a 404 like any other.
 */
export interface PeerAppDeps {
  /** The part of this machine's API a paired machine may call (forward.ts); null until the container is up. */
  forwardedApi?: () => { fetch: (req: Request, env: { peerNodeId: string }) => Response | Promise<Response> } | null;
  /** How often an idle `/peer/events` stream sends a keepalive; defaults to PEER_EVENTS_KEEPALIVE_MS. */
  keepaliveMs?: number;
}

export function createPeerApp(service: PeerService, deps: PeerAppDeps = {}): Hono<PeerEnv> {
  const app = new Hono<PeerEnv>();

  app.onError((err, c) => {
    if (err instanceof PeerError) return c.json({ error: err.message }, err.status);
    console.error('[grunt-server] peer listener error:', err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  // Anyone who can reach the listener can call this one while a code is open, so its body is kept small.
  app.post('/peer/pair', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'Pairing request too large.' }, 413) }), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as PairRequest;
    const remote = c.env?.incoming?.socket?.remoteAddress ?? null;
    return c.json(await service.acceptPairing(body, callerFingerprint(c), remote));
  });

  // Every other route: a paired machine only.
  const pairedOnly = async (c: Context<PeerEnv>, next: () => Promise<void>): Promise<Response | void> => {
    const peer = service.authenticate(callerFingerprint(c), bearer(c));
    if (!peer) return c.json({ error: 'Not a paired machine.' }, 401);
    c.set('peer', peer);
    await next();
  };
  app.use('/peer/*', pairedOnly);
  app.use('/api/*', pairedOnly);

  /** Running a chat that runs here, for the paired machine whose UI it's open in (Task 52). */
  app.all('/api/*', async (c) => {
    const api = deps.forwardedApi?.();
    if (!api) return c.json({ error: 'Not found.' }, 404);
    const url = new URL(c.req.url);
    url.pathname = url.pathname.replace(/^\/api/, '');
    return api.fetch(new Request(url, c.req.raw), { peerNodeId: c.get('peer').nodeId });
  });

  app.get('/peer/info', (c) => c.json(service.info()));

  /** Held open by each paired machine: a hello, then whatever this machine announces (Task 51: new changes). */
  app.get('/peer/events', (c) => {
    const peer = c.get('peer');
    return sseStream((sink) => {
      sink.send('hello', service.info());
      const unregister = service.openEventStream(peer.nodeId, (event, data) => sink.send(event, data), () => sink.close());
      const keepalive = setInterval(() => sink.comment('keepalive'), deps.keepaliveMs ?? PEER_EVENTS_KEEPALIVE_MS);
      return () => {
        clearInterval(keepalive);
        unregister();
      };
    });
  });

  /** This machine's changes after the caller's cursor (Task 50), keys included unless kept here. */
  app.get('/peer/changes', async (c) => {
    const since = Number(c.req.query('since') ?? 0);
    const limit = Number(c.req.query('limit') ?? 500);
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1) return c.json({ error: 'Bad since or limit.' }, 400);
    return c.json(await service.requireSyncer().changesFor(since, limit));
  });

  /** A file's bytes by hash: only files sent in a message ever leave this machine. */
  app.get('/peer/blobs/:sha256', async (c) => {
    const data = await service.requireSyncer().blob(c.req.param('sha256'));
    if (!data) return c.json({ error: 'No such file.' }, 404);
    return c.body(new Uint8Array(data), 200, { 'Content-Type': 'application/octet-stream' });
  });

  /** The caller has changes for this machine: pull them now, and answer when done (before forwarding a turn, Task 52). */
  app.post('/peer/sync-request', async (c) => c.json({ applied: await service.requireSyncer().pullFrom(c.get('peer').nodeId) }));

  /** The caller removed this machine: forget it here too. */
  app.post('/peer/revoke', async (c) => {
    await service.revokedBy(c.get('peer'));
    return c.body(null, 204);
  });

  return app;
}
