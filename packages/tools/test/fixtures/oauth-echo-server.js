#!/usr/bin/env node
// A fake OAuth sign-in provider and MCP server on one loopback port, for the
// MCP sign-in tests (spec 2026-10-12-mcp-oauth-design §8). The MCP side is
// echo-server.js's `buildServer()`, served statelessly as `serveHttp` does,
// but only to a valid bearer token; without one /mcp answers 401 with an
// RFC 9728 `resource_metadata` challenge. The OAuth side has discovery,
// dynamic registration (unless `dcr: false`), /authorize (no login page:
// it redirects straight back with a code, or error=access_denied when told
// to deny) and /token (authorization_code with PKCE S256, refresh_token
// with optional rotation, client secrets by Basic or POST).
//
// Manual testing: `node test/fixtures/oauth-echo-server.js --port 4800`
// prints `LISTENING <mcp url>`; add it to Grunt as an http server.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './echo-server.js';

const random = () => randomBytes(24).toString('base64url');
const b64urlJson = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

/**
 * @param {{ port?: number, dcr?: boolean, rotate?: boolean, idTokenEmail?: string | null, staticClients?: Record<string, string | null>, tokenEcho?: boolean, registerError?: string | null, registerGate?: Promise<void> | null }} [opts]
 */
export async function startOAuthEchoServer(opts = {}) {
  const dcr = opts.dcr ?? true;
  const rotate = opts.rotate ?? false;
  const idTokenEmail = opts.idTokenEmail ?? null;
  const tokenEcho = opts.tokenEcho ?? false;
  const registerError = opts.registerError ?? null;
  /** A promise registration waits on before answering, so a test can act while a sign-in start is still connecting. */
  const registerGate = opts.registerGate ?? null;
  let registerRequests = 0;
  /** Every POST /token body as a plain object (so a test can look up the PKCE verifier the client sent). */
  const tokenRequests = [];

  /** client_id -> { secret: string | null, redirectUris: string[] | null }; null redirectUris: any 127.0.0.1 /oauth/callback (hand-registered). */
  const clients = new Map();
  for (const [id, secret] of Object.entries(opts.staticClients ?? {})) clients.set(id, { secret, redirectUris: null });
  /** code -> { clientId, redirectUri, challenge } */
  const codes = new Map();
  const accessTokens = new Set();
  /** refresh token -> client_id */
  const refreshTokens = new Map();
  const registrations = [];
  const issued = { accessTokens: [], refreshTokens: [], idTokens: [] };
  let deny = false;
  let tokenDown = false;
  let mcpRequests = 0;
  let origin = '';

  const redirectAllowed = (client, redirectUri) =>
    client.redirectUris === null ? /^http:\/\/127\.0\.0\.1(:\d+)?\/oauth\/callback$/.test(redirectUri) : client.redirectUris.includes(redirectUri);

  /** The authenticated client_id (Basic header or POST body), or null. */
  function authenticateClient(req, params) {
    let clientId = params.get('client_id');
    let secret = params.get('client_secret');
    const header = req.headers.authorization;
    if (header?.startsWith('Basic ')) {
      const raw = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const colon = raw.indexOf(':');
      clientId = raw.slice(0, colon);
      secret = raw.slice(colon + 1);
    }
    const client = clientId ? clients.get(clientId) : undefined;
    if (!client) return null;
    if (client.secret !== null && client.secret !== secret) return null;
    return clientId;
  }

  function issueTokens(clientId, withRefresh) {
    const access = `at-${random()}`;
    accessTokens.add(access);
    issued.accessTokens.push(access);
    const body = { access_token: access, token_type: 'Bearer', expires_in: 3600 };
    if (withRefresh) {
      const refresh = `rt-${random()}`;
      refreshTokens.set(refresh, clientId);
      issued.refreshTokens.push(refresh);
      body.refresh_token = refresh;
    }
    if (idTokenEmail) {
      const idToken = `${b64urlJson({ alg: 'none', typ: 'JWT' })}.${b64urlJson({ iss: origin, sub: 'fixture-user', aud: clientId, email: idTokenEmail })}.fixture`;
      issued.idTokens.push(idToken);
      body.id_token = idToken;
    }
    return body;
  }

  const protectedResource = () => ({ resource: `${origin}/mcp`, authorization_servers: [origin] });
  const authorizationServer = () => ({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    ...(dcr ? { registration_endpoint: `${origin}/register` } : {}),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  });

  async function handleRegister(req, res) {
    if (!dcr) return sendJson(res, 404, { error: 'not_found' });
    registerRequests += 1;
    if (registerGate) await registerGate;
    if (registerError) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(registerError);
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'invalid_client_metadata' });
    }
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) return sendJson(res, 400, { error: 'invalid_redirect_uri' });
    const clientId = `dcr-${random()}`;
    const secret = body.token_endpoint_auth_method === 'none' ? null : `secret-${random()}`;
    clients.set(clientId, { secret, redirectUris: body.redirect_uris });
    registrations.push({ clientId, metadata: body });
    sendJson(res, 201, { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), ...(secret ? { client_secret: secret } : {}) });
  }

  function handleAuthorize(url, res) {
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const client = clients.get(clientId);
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!client || !redirectAllowed(client, redirectUri)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Unknown client or redirect address.');
      return;
    }
    const back = new URL(redirectUri);
    const state = q.get('state');
    if (state !== null) back.searchParams.set('state', state);
    if (deny) {
      back.searchParams.set('error', 'access_denied');
    } else if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      back.searchParams.set('error', 'invalid_request');
    } else {
      const code = `code-${random()}`;
      codes.set(code, { clientId, redirectUri, challenge: q.get('code_challenge') });
      back.searchParams.set('code', code);
    }
    res.writeHead(302, { Location: back.href }).end();
  }

  async function handleToken(req, res) {
    if (tokenDown) {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Service unavailable');
      return;
    }
    const rawBody = await readBody(req);
    const params = new URLSearchParams(rawBody);
    tokenRequests.push(Object.fromEntries(params));
    if (tokenEcho) {
      // A careless provider that answers an error by repeating the request (body, and Basic credentials decoded) back.
      const header = req.headers.authorization ?? '';
      const basic = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`bad request: ${rawBody} ${header} ${basic}`);
      return;
    }
    const clientId = authenticateClient(req, params);
    if (!clientId) return sendJson(res, 401, { error: 'invalid_client' });
    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      const code = params.get('code') ?? '';
      const entry = codes.get(code);
      codes.delete(code); // single use, whatever happens next
      const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
      if (!entry || entry.clientId !== clientId || entry.redirectUri !== params.get('redirect_uri') || entry.challenge !== challenge) {
        return sendJson(res, 400, { error: 'invalid_grant' });
      }
      return sendJson(res, 200, issueTokens(clientId, true));
    }
    if (grant === 'refresh_token') {
      const old = params.get('refresh_token') ?? '';
      if (refreshTokens.get(old) !== clientId) return sendJson(res, 400, { error: 'invalid_grant' });
      if (rotate) refreshTokens.delete(old);
      return sendJson(res, 200, issueTokens(clientId, rotate));
    }
    return sendJson(res, 400, { error: 'unsupported_grant_type' });
  }

  function handleMcp(req, res) {
    mcpRequests += 1;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!accessTokens.has(token)) {
      res
        .writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    void (async () => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await transport.close().catch(() => {});
      }
    })();
  }

  const fail = (res) => (err) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
  };

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const route = `${req.method} ${url.pathname}`;
    if (url.pathname === '/mcp') return handleMcp(req, res);
    if (route === 'GET /.well-known/oauth-protected-resource' || route === 'GET /.well-known/oauth-protected-resource/mcp') return sendJson(res, 200, protectedResource());
    if (route === 'GET /.well-known/oauth-authorization-server') return sendJson(res, 200, authorizationServer());
    if (route === 'POST /register') return void handleRegister(req, res).catch(fail(res));
    if (route === 'GET /authorize') return handleAuthorize(url, res);
    if (route === 'POST /token') return void handleToken(req, res).catch(fail(res));
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, '127.0.0.1', () => resolve(undefined));
  });
  origin = `http://127.0.0.1:${httpServer.address().port}`;

  return {
    origin,
    url: `${origin}/mcp`,
    registrations,
    issued,
    tokenRequests,
    registerRequests: () => registerRequests,
    mcpRequests: () => mcpRequests,
    expireAccessTokens: () => accessTokens.clear(),
    revokeRefreshTokens: () => refreshTokens.clear(),
    setDeny: (value) => {
      deny = value;
    },
    setTokenDown: (value) => {
      tokenDown = value;
    },
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve(undefined));
      }),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const portFlag = process.argv.indexOf('--port');
  const fixture = await startOAuthEchoServer({ port: portFlag !== -1 ? Number(process.argv[portFlag + 1]) : 0, rotate: true, idTokenEmail: 'you@example.com' });
  console.log(`LISTENING ${fixture.url}`);
}
