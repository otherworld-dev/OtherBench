import { describe, it, expect } from 'vitest';
import { fetchWithServerHeaders } from '../../src/mcp/client.js';
import { checkAuthorizationUrl, SignInError } from '../../src/mcp/sign-in.js';
import { mcpServerUrlProblem, normaliseResource, parseHttpUrl, resourceCovers, sameIssuer, sameOrigin, sameResource } from '../../src/mcp/url.js';

const MCP = 'https://mcp.example.com/mcp';

describe('url.ts: parsing and refusals', () => {
  it('refuses userinfo, in every spelling', () => {
    for (const raw of ['https://good@evil.example/mcp', 'https://good.example:pw@evil.example/mcp', 'https://@evil.example/mcp', 'https://a%40b@evil.example/']) {
      expect(parseHttpUrl(raw)).toBeNull();
      expect(normaliseResource(raw)).toBeNull();
      expect(mcpServerUrlProblem(raw)).toMatch(/user name or password/);
    }
    expect(sameOrigin('https://good@evil.example/', 'https://evil.example/')).toBe(false);
    expect(sameResource('https://good@mcp.example.com/mcp', MCP)).toBe(false);
  });

  it('refuses a backslash, which WHATWG reads as a slash and other parsers do not', () => {
    const raw = 'https://good.example\\@evil.example/mcp';
    expect(new URL(raw).hostname).toBe('good.example'); // what fetch would do
    expect(parseHttpUrl(raw)).toBeNull();
    expect(parseHttpUrl('https://mcp.example.com\\mcp')).toBeNull();
    expect(mcpServerUrlProblem('https://mcp.example.com\\mcp')).toMatch(/backslash/);
  });

  it('refuses whitespace and control characters, other schemes and garbage', () => {
    for (const raw of [' https://mcp.example.com/mcp', 'https://mcp.example.com/m\tcp', 'https://mcp.example.com/m\ncp', 'ftp://mcp.example.com/', 'javascript:alert(1)', 'not a url']) {
      expect(parseHttpUrl(raw)).toBeNull();
    }
  });

  it('accepts an ordinary address and has no problem with it', () => {
    expect(parseHttpUrl(MCP)?.href).toBe(MCP);
    expect(mcpServerUrlProblem(MCP)).toBeNull();
    expect(mcpServerUrlProblem(null)).toBeNull();
  });
});

describe('url.ts: normalised resources', () => {
  it('upper-case host, trailing dot and default port name the same resource', () => {
    for (const raw of ['https://MCP.Example.COM/mcp', 'https://mcp.example.com./mcp', 'https://mcp.example.com:443/mcp', 'https://mcp.example.com/mcp#frag', 'https://mcp.example.com/mcp?x=1']) {
      expect(normaliseResource(raw)).toBe('https://mcp.example.com/mcp');
      expect(sameResource(raw, MCP)).toBe(true);
    }
    expect(normaliseResource('http://mcp.example.com:80/mcp')).toBe('http://mcp.example.com/mcp');
  });

  it('another port, scheme or host is another resource', () => {
    for (const raw of ['https://mcp.example.com:8443/mcp', 'http://mcp.example.com/mcp', 'https://mcp.example.com.evil.example/mcp', 'https://evil.example/mcp']) {
      expect(sameResource(raw, MCP)).toBe(false);
    }
  });

  it('percent-encoding follows RFC 3986: unreserved decoded, hex upper-cased, a slash stays encoded', () => {
    expect(sameResource('https://mcp.example.com/m%63p', MCP)).toBe(true);
    expect(normaliseResource('https://mcp.example.com/a%2fb')).toBe('https://mcp.example.com/a%2Fb');
    expect(sameResource('https://mcp.example.com/a%2Fb', 'https://mcp.example.com/a/b')).toBe(false);
  });

  it('IDN hosts compare by their punycode form', () => {
    expect(sameResource('https://bücher.example/mcp', 'https://xn--bcher-kva.example/mcp')).toBe(true);
  });

  it('the path is kept exactly: /mcp, /mcp/ and /mcp-evil are three resources', () => {
    expect(sameResource(MCP, 'https://mcp.example.com/mcp-evil')).toBe(false);
    expect(sameResource(MCP, 'https://mcp.example.com/mcp/')).toBe(false);
    expect(sameResource(MCP, 'https://mcp.example.com/MCP')).toBe(false);
  });

  it('a missing address is never the same resource', () => {
    expect(sameResource(null, MCP)).toBe(false);
    expect(sameResource(MCP, undefined)).toBe(false);
  });
});

describe('url.ts: origins, protected-resource metadata and issuers', () => {
  it('sameOrigin ignores the path (origin is origin) and normalises host and port', () => {
    expect(sameOrigin(MCP, 'https://mcp.example.com/mcp-evil')).toBe(true);
    expect(sameOrigin(MCP, 'https://MCP.example.com.:443/token')).toBe(true);
    expect(sameOrigin(MCP, 'https://mcp.example.com:8443/mcp')).toBe(false);
    expect(sameOrigin(MCP, 'https://auth.example.com/token')).toBe(false);
  });

  it('resourceCovers: the root and the exact path cover the server, a sibling or another origin does not', () => {
    expect(resourceCovers(MCP, 'https://mcp.example.com/')).toBe(true);
    expect(resourceCovers(MCP, 'https://MCP.example.com:443/mcp')).toBe(true);
    expect(resourceCovers('https://mcp.example.com/mcp/sub', MCP)).toBe(true);
    expect(resourceCovers('https://mcp.example.com/mcp-evil', MCP)).toBe(false);
    expect(resourceCovers(MCP, 'https://mcp.example.com/mcp-evil')).toBe(false);
    expect(resourceCovers(MCP, 'https://mcp.example.com/mcp/sub')).toBe(false);
    expect(resourceCovers(MCP, 'https://evil.example/mcp')).toBe(false);
    expect(resourceCovers(MCP, 'https://good@mcp.example.com/mcp')).toBe(false);
  });

  it('sameIssuer: the address it was found at, path included, no query or fragment', () => {
    expect(sameIssuer('https://auth.example.com', 'https://auth.example.com/')).toBe(true);
    expect(sameIssuer('https://Auth.Example.com:443/tenant', 'https://auth.example.com/tenant')).toBe(true);
    expect(sameIssuer('https://auth.example.com/other', 'https://auth.example.com/tenant')).toBe(false);
    expect(sameIssuer('https://evil.example', 'https://auth.example.com')).toBe(false);
    expect(sameIssuer('https://auth.example.com?x=1', 'https://auth.example.com')).toBe(false);
    expect(sameIssuer('https://good@auth.example.com', 'https://auth.example.com')).toBe(false);
  });

  it('checkAuthorizationUrl refuses userinfo and a backslash, and normalises a loopback host', () => {
    expect(() => checkAuthorizationUrl(new URL('https://user@auth.example.com/authorize'))).toThrow(SignInError);
    expect(() => checkAuthorizationUrl(new URL('http://LOCALHOST:9000/authorize'))).not.toThrow();
    expect(() => checkAuthorizationUrl(new URL('http://localhost.:9000/authorize'))).not.toThrow();
    expect(() => checkAuthorizationUrl(new URL('http://127.0.0.1.evil.example/authorize'))).toThrow(SignInError);
  });
});

describe('fetchWithServerHeaders', () => {
  async function headersSentTo(url: string): Promise<string | null> {
    let seen: string | null = null;
    const base = (_url: string | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers).get('x-api-key');
      return Promise.resolve(new Response('ok'));
    };
    await fetchWithServerHeaders(MCP, { 'X-Api-Key': 'key-1234567890' }, base)(url, { headers: { Accept: 'application/json' } });
    return seen;
  }

  it('adds the headers for the server origin, whatever the path or spelling of host and port', async () => {
    expect(await headersSentTo(MCP)).toBe('key-1234567890');
    expect(await headersSentTo('https://mcp.example.com/mcp-evil')).toBe('key-1234567890'); // same origin: no special case for the path
    expect(await headersSentTo('https://MCP.example.com.:443/.well-known/oauth-protected-resource')).toBe('key-1234567890');
  });

  it('never adds them for another origin, or an address with userinfo', async () => {
    expect(await headersSentTo('https://auth.example.com/token')).toBeNull();
    expect(await headersSentTo('https://mcp.example.com:8443/mcp')).toBeNull();
    expect(await headersSentTo('https://mcp.example.com@evil.example/mcp')).toBeNull();
    expect(await headersSentTo('https://mcp.example.com.evil.example/mcp')).toBeNull();
  });
});
