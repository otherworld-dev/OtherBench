import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InsecurePublicUrlError } from '../../src/remote/errors.js';
import { createRemoteAccess } from '../../src/remote/index.js';
import { parsePublicUrl } from '../../src/remote/public-url.js';

describe('parsePublicUrl', () => {
  it('normalises case, a trailing slash and the default port', () => {
    expect(parsePublicUrl('https://OtherBench.LAN:4747/')).toEqual({ origin: 'https://otherbench.lan:4747', host: 'otherbench.lan:4747', hostname: 'otherbench.lan' });
    expect(parsePublicUrl('https://otherbench.example.com:443')).toEqual({ origin: 'https://otherbench.example.com', host: 'otherbench.example.com', hostname: 'otherbench.example.com' });
  });

  it('takes an IPv6 address, keeping the brackets in the host but not the hostname', () => {
    expect(parsePublicUrl('https://[FD00::5]:4747')).toEqual({ origin: 'https://[fd00::5]:4747', host: '[fd00::5]:4747', hostname: 'fd00::5' });
  });

  it.each(['http://otherbench.lan:4747', 'https://otherbench.lan/otherbench', 'https://otherbench.lan/?x=1', 'https://otherbench.lan/?', 'https://otherbench.lan/#a', 'https://adam:pw@otherbench.lan', 'otherbench.lan', 'not a url'])(
    'refuses %s',
    (raw) => {
      expect(() => parsePublicUrl(raw)).toThrow(InsecurePublicUrlError);
    }
  );
});

describe('createRemoteAccess', () => {
  it('holds the origins, hosts, hostnames and normalised trusted proxies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'otherbench-remote-'));
    const remote = createRemoteAccess({
      publicUrls: ['https://OtherBench.LAN:4747/', 'https://192.168.1.5:4747', 'https://otherbench.lan:4747'],
      trustProxies: ['::ffff:127.0.0.1'],
      loginPath: join(dir, 'login.json'),
      tls: { mode: 'proxy' },
    });
    try {
      expect(remote.publicOrigins).toEqual(['https://otherbench.lan:4747', 'https://192.168.1.5:4747']);
      expect(remote.publicHosts).toEqual(['otherbench.lan:4747', '192.168.1.5:4747']);
      expect(remote.publicHostnames).toEqual(['otherbench.lan', '192.168.1.5']);
      expect(remote.trustProxies).toEqual(['127.0.0.1']);
    } finally {
      remote.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
