import { describe, it, expect, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { startOAuthEchoServer } from '../fixtures/oauth-echo-server.js';

const REDIRECT = 'http://127.0.0.1:4747/oauth/callback';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function start(opts = {}) {
  const fixture = await startOAuthEchoServer(opts);
  closers.push(() => fixture.close());
  return fixture;
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

function postMcp(url: string, token?: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(initialize),
  });
}

describe('oauth-echo-server fixture', () => {
  it('answers /mcp without a token with 401 and a resource_metadata challenge, and serves its discovery documents', async () => {
    const fixture = await start();
    const res = await postMcp(fixture.url);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${fixture.origin}/.well-known/oauth-protected-resource/mcp"`);

    const prm = await (await fetch(`${fixture.origin}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toEqual({ resource: fixture.url, authorization_servers: [fixture.origin] });
    const as = (await (await fetch(`${fixture.origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: fixture.origin, registration_endpoint: `${fixture.origin}/register`, code_challenge_methods_supported: ['S256'] });

    const noDcr = await start({ dcr: false });
    const asNoDcr = (await (await fetch(`${noDcr.origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(asNoDcr['registration_endpoint']).toBeUndefined();
  });

  it('registers, authorizes with PKCE, issues tokens with an id_token, and serves the echo server to the bearer', async () => {
    const fixture = await start({ idTokenEmail: 'alice@example.com' });
    const reg = await fetch(`${fixture.origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Grunt', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    expect(fixture.registrations).toHaveLength(1);

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${fixture.origin}/authorize`);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1' })) authorize.searchParams.set(k, v);
    const redirect = await fetch(authorize, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    const back = new URL(redirect.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st-1');

    const token = await fetch(`${fixture.origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT, client_id }),
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as { access_token: string; refresh_token: string; id_token: string };
    expect(fixture.issued.accessTokens).toEqual([tokens.access_token]);
    expect(JSON.parse(Buffer.from(tokens.id_token.split('.')[1]!, 'base64url').toString())).toMatchObject({ email: 'alice@example.com' });

    expect((await postMcp(fixture.url, tokens.access_token)).status).toBe(200);
    fixture.expireAccessTokens();
    expect((await postMcp(fixture.url, tokens.access_token)).status).toBe(401);
  });

  it('refuses a wrong PKCE verifier, and redirects with error=access_denied when told to deny', async () => {
    const fixture = await start({ staticClients: { 'manual-1': null } });
    const challenge = createHash('sha256').update('right').digest('base64url');
    const authorize = (deny: boolean) => {
      fixture.setDeny(deny);
      const u = new URL(`${fixture.origin}/authorize`);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: 'manual-1', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's' })) u.searchParams.set(k, v);
      return fetch(u, { redirect: 'manual' });
    };
    const denied = new URL((await authorize(true)).headers.get('location')!);
    expect(denied.searchParams.get('error')).toBe('access_denied');

    const ok = new URL((await authorize(false)).headers.get('location')!);
    const res = await fetch(`${fixture.origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: ok.searchParams.get('code')!, code_verifier: 'wrong', redirect_uri: REDIRECT, client_id: 'manual-1' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
  });
});
