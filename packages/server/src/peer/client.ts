import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { connect, type TLSSocket } from 'node:tls';
import { fingerprintOf } from '@otherbench/core/domain/pairing.js';
import type { NodeIdentity } from './identity.js';

/** The peer listener's default port (v2 spec §1). */
export const DEFAULT_PEER_PORT = 4748;
const CONNECT_TIMEOUT_MS = 5_000;

/** The certificate at an address isn't the one pinned for that machine. */
export class PinMismatchError extends Error {
  constructor(
    readonly address: string,
    readonly fingerprint: string
  ) {
    super(`${address} presented a different certificate than the one paired with.`);
    this.name = 'PinMismatchError';
  }
}

/** No address of a peer could be reached (or each presented the wrong certificate). */
export class PeerUnreachableError extends Error {
  constructor(readonly failures: { address: string; error: string }[]) {
    super(failures.length === 0 ? 'The machine has no addresses to try.' : `Couldn't reach the machine: ${failures.map((f) => `${f.address} (${f.error})`).join('; ')}.`);
    this.name = 'PeerUnreachableError';
  }
}

/** `host:port`, `[v6]:port` or a bare host (the default peer port). */
export function parsePeerAddress(address: string): { host: string; port: number } {
  const trimmed = address.trim();
  const v6 = trimmed.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : DEFAULT_PEER_PORT };
  const parts = trimmed.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1]!)) return { host: parts[0]!, port: Number(parts[1]) };
  if (isIP(trimmed) === 6) return { host: trimmed, port: DEFAULT_PEER_PORT };
  return { host: trimmed, port: DEFAULT_PEER_PORT };
}

/** Where to connect, and which certificate to insist on; `fingerprint: null` only for pairing, which reports what it saw. */
export interface PeerTarget {
  addresses: string[];
  fingerprint: string | null;
}

export interface PeerConnection {
  socket: TLSSocket;
  address: string;
  /** The certificate the other side presented. */
  fingerprint: string;
}

export interface PeerRequest {
  method: string;
  path: string;
  /** The bearer token the peer issued us; omitted only for pairing. */
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Limits on one JSON exchange with a peer. */
export interface ResponseLimits {
  timeoutMs?: number;
  maxBytes?: number;
  /** The body as bytes (a blob) rather than parsed JSON. */
  binary?: boolean;
}

/** Room for a sync batch (Task 50 sizes its batches to stay well under this). */
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000;

export interface PeerResponse {
  status: number;
  body: unknown;
  address: string;
  fingerprint: string;
}

/**
 * Talks to other machines' peer listeners (v2 plan, Tasks 46-48). Every
 * connection presents this node's certificate and is checked against the
 * pinned fingerprint as soon as the handshake completes -- before a single
 * byte of the request, the bearer token included, is written. Addresses are
 * tried in the order given (the caller keeps the last one that worked first).
 */
export class PeerClient {
  constructor(private readonly identity: () => NodeIdentity) {}

  /** One pinned TLS connection to `address`. Rejects with `PinMismatchError` on the wrong certificate. */
  connectTo(address: string, fingerprint: string | null): Promise<PeerConnection> {
    const { host, port } = parsePeerAddress(address);
    const own = this.identity();
    return new Promise((resolve, reject) => {
      const socket = connect({
        host,
        port,
        key: own.keyPem,
        cert: own.certPem,
        // The certificate is self-signed: it's checked by pinning below, not by a CA.
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        ...(isIP(host) ? {} : { servername: host }),
      });
      const timer = setTimeout(() => socket.destroy(new Error('timed out')), CONNECT_TIMEOUT_MS);
      const onError = (err: Error): void => {
        clearTimeout(timer);
        reject(err);
      };
      socket.once('error', onError);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        const raw = socket.getPeerCertificate().raw as Buffer | undefined;
        const seen = raw ? fingerprintOf(raw) : '';
        if (!seen || (fingerprint !== null && seen !== fingerprint)) {
          socket.destroy();
          reject(new PinMismatchError(address, seen));
          return;
        }
        // From here errors reach whoever uses the socket (the HTTP request
        // sees them as its own); this only stops one arriving in between
        // from being an unhandled 'error' event.
        socket.on('error', () => {});
        resolve({ socket, address, fingerprint: seen });
      });
    });
  }

  /** A pinned connection to the first of `target.addresses` that answers. */
  async connect(target: PeerTarget): Promise<PeerConnection> {
    const failures: { address: string; error: string }[] = [];
    for (const address of target.addresses) {
      try {
        return await this.connectTo(address, target.fingerprint);
      } catch (err) {
        failures.push({ address, error: err instanceof Error ? err.message : String(err) });
      }
    }
    throw new PeerUnreachableError(failures);
  }

  /** Sends one request on an already-pinned connection and returns the raw response; the connection closes with it. */
  send(conn: PeerConnection, req: PeerRequest): Promise<IncomingMessage> {
    const { host } = parsePeerAddress(conn.address);
    const payload = req.body === undefined ? null : Buffer.from(JSON.stringify(req.body));
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          createConnection: () => conn.socket,
          host,
          method: req.method,
          path: req.path,
          headers: {
            connection: 'close',
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
            ...(req.token ? { authorization: `Bearer ${req.token}` } : {}),
            ...req.headers,
          },
        },
        resolve
      );
      outgoing.once('error', reject);
      outgoing.end(payload ?? undefined);
    });
  }

  /** A JSON request to the peer: connect (pinned), send, read the whole body. */
  async request(target: PeerTarget, req: PeerRequest, limits: ResponseLimits = {}): Promise<PeerResponse> {
    const conn = await this.connect(target);
    return this.requestOn(conn, req, limits);
  }

  /**
   * As `request`, on a connection already made (pairing reuses the one it
   * inspected). The whole exchange must finish within `timeoutMs` and the
   * body stay under `maxBytes`, or the connection is dropped: a peer, or
   * whatever answered in its place, can't hold this machine waiting or fill
   * its memory.
   */
  async requestOn(conn: PeerConnection, req: PeerRequest, limits: ResponseLimits = {}): Promise<PeerResponse> {
    const timeoutMs = limits.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    const maxBytes = limits.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const timer = setTimeout(() => conn.socket.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    let chunks: Buffer[];
    let res: IncomingMessage;
    try {
      res = await this.send(conn, req);
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > maxBytes) throw new Error(`answer too large (${declared} bytes)`);
      chunks = [];
      let size = 0;
      for await (const chunk of res) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) throw new Error(`answer too large (over ${maxBytes} bytes)`);
        chunks.push(chunk as Buffer);
      }
    } catch (err) {
      conn.socket.destroy();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (limits.binary) return { status: res.statusCode ?? 0, body: Buffer.concat(chunks), address: conn.address, fingerprint: conn.fingerprint };
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = text;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // not JSON: keep the text
    }
    return { status: res.statusCode ?? 0, body, address: conn.address, fingerprint: conn.fingerprint };
  }

  /** A streaming request (SSE): the caller reads `response` and calls `close()` when done. */
  async stream(target: PeerTarget, req: PeerRequest): Promise<{ response: IncomingMessage; address: string; close: () => void }> {
    const conn = await this.connect(target);
    const response = await this.send(conn, req);
    return { response, address: conn.address, close: () => conn.socket.destroy() };
  }
}
