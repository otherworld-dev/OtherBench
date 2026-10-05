import { createServer, type Server } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { PeerClient, parsePeerAddress } from '../../src/peer/client.js';
import { IdentityStore } from '../../src/peer/identity.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A TLS server that answers every request with `reply` (raw HTTP), or never answers when null. */
async function rawServer(reply: string | null): Promise<{ address: string; fingerprint: string }> {
  const identity = new IdentityStore(() => 'raw', null).get();
  const server = createServer({ key: identity.keyPem, cert: identity.certPem }, (socket) => {
    socket.on('error', () => {});
    socket.once('data', () => {
      if (reply !== null) socket.end(reply);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { address: `127.0.0.1:${(server.address() as { port: number }).port}`, fingerprint: identity.fingerprint };
}

const client = new PeerClient(() => new IdentityStore(() => 'client', null).get());

describe('PeerClient limits', () => {
  it('drops an answer larger than allowed, by its declared length or as it streams in', async () => {
    const declared = await rawServer('HTTP/1.1 200 OK\r\ncontent-length: 999999999\r\n\r\n');
    await expect(client.request({ addresses: [declared.address], fingerprint: declared.fingerprint }, { method: 'GET', path: '/' }, { maxBytes: 1024 })).rejects.toThrow(/too large/);

    const streamed = await rawServer(`HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n${'x'.repeat(4096)}`);
    await expect(client.request({ addresses: [streamed.address], fingerprint: streamed.fingerprint }, { method: 'GET', path: '/' }, { maxBytes: 1024 })).rejects.toThrow(/too large/);
  });

  it('gives up on a machine that never answers', async () => {
    const silent = await rawServer(null);
    await expect(client.request({ addresses: [silent.address], fingerprint: silent.fingerprint }, { method: 'GET', path: '/' }, { timeoutMs: 200 })).rejects.toThrow(/no answer within/);
  });

  it('reads a normal JSON answer', async () => {
    const ok = await rawServer('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{"ok":true}');
    expect(await client.request({ addresses: [ok.address], fingerprint: ok.fingerprint }, { method: 'GET', path: '/' })).toMatchObject({ status: 200, body: { ok: true } });
  });
});

describe('parsePeerAddress', () => {
  it('host:port, [v6]:port, and a bare host on the default port', () => {
    expect(parsePeerAddress('192.168.1.2:5000')).toEqual({ host: '192.168.1.2', port: 5000 });
    expect(parsePeerAddress('pc.lan')).toEqual({ host: 'pc.lan', port: 4748 });
    expect(parsePeerAddress('[fe80::1]:4749')).toEqual({ host: 'fe80::1', port: 4749 });
    expect(parsePeerAddress('fe80::1')).toEqual({ host: 'fe80::1', port: 4748 });
  });
});
