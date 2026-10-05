import { createServer, type Server } from 'node:https';
import { networkInterfaces } from 'node:os';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import type { IdentityStore } from './identity.js';

/** True for a wildcard bind address: every interface. */
function isWildcard(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '';
}

/** This machine's non-internal IPv4 addresses, for showing on the pairing screen. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/**
 * The peer listener (v2 spec §1, §8): HTTPS only, presenting this node's
 * certificate and asking for the caller's. It doesn't reject callers
 * without one at the TLS layer -- pairing needs to reach it first -- so every
 * route but pairing checks the caller's certificate and token itself
 * (peer/app.ts). Bound only to the chosen hosts, and only running while a
 * peer exists or a pairing code is open: `PeerService` starts and stops it.
 */
export class PeerListener {
  private servers: Server[] = [];
  private boundPort: number | null = null;
  /** With port 0, the port the last run got, tried first next time so peers' stored addresses keep working. */
  private lastPort: number | null = null;

  constructor(
    private readonly app: Hono<never>,
    private readonly identity: IdentityStore,
    private readonly port: number,
    private readonly hosts: string[]
  ) {}

  get running(): boolean {
    return this.servers.length > 0;
  }

  /** The port actually bound (differs from the requested one for port 0), or null when stopped. */
  get listeningPort(): number | null {
    return this.boundPort;
  }

  /** `host:port` addresses another machine could use to reach this one. */
  addresses(): string[] {
    if (this.boundPort === null) return [];
    const hosts = this.hosts.flatMap((h) => (isWildcard(h) ? lanAddresses() : [h]));
    return [...new Set(hosts)].map((h) => (h.includes(':') ? `[${h}]:${this.boundPort}` : `${h}:${this.boundPort}`));
  }

  async start(): Promise<void> {
    if (this.running) return;
    const { keyPem, certPem } = this.identity.get();
    const listener = getRequestListener(this.app.fetch);
    if (this.port === 0 && this.lastPort !== null) {
      try {
        await this.bind(listener, keyPem, certPem, this.lastPort);
        return;
      } catch {
        await this.stop();
      }
    }
    await this.bind(listener, keyPem, certPem, this.port);
  }

  private async bind(listener: ReturnType<typeof getRequestListener>, keyPem: string, certPem: string, requested: number): Promise<void> {
    let port = requested;
    try {
      for (const host of this.hosts) {
        const server = createServer({ key: keyPem, cert: certPem, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, listener);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        // Every host shares the port the first one got.
        port = (server.address() as { port: number }).port;
        this.servers.push(server);
      }
      this.boundPort = port;
      this.lastPort = port;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    this.boundPort = null;
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections();
          })
      )
    );
  }
}
