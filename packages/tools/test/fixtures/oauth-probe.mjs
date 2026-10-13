// Live probe (manual, read-only): what do two public MCP servers advertise
// for OAuth sign-in? Run from packages/tools:
//   node test/fixtures/oauth-probe.mjs
//
// It only GETs public discovery metadata -- RFC 9728 protected-resource
// metadata, then RFC 8414 / OpenID authorization-server metadata -- through
// the MCP SDK's own discovery code. It registers no client, starts no
// sign-in and sends no POST: `getOnly` below refuses any other method.
// Whether a provider accepts Grunt's loopback redirect
// (http://127.0.0.1:<port>/oauth/callback) can only be learned by
// registering, which is Adam's live check (docs/HANDOVER.md, "Sign-in for
// HTTP MCP servers").
//
// Found (run 2026-10-12):
//   https://mcp.notion.com/mcp
//     protected-resource metadata: yes (resource https://mcp.notion.com/mcp)
//     authorization server: https://mcp.notion.com
//     authorization_endpoint is https: true
//     registration_endpoint (dynamic registration): yes
//     token_endpoint_auth_methods_supported: ["client_secret_basic","client_secret_post","none"]
//     public client ('none') allowed: true
//     code_challenge_methods_supported: ["S256"]
//     grant_types_supported: ["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"]
//     scopes_supported: ["default"]
//     client_id_metadata_document_supported: true
//   https://mcp.linear.app/mcp
//     protected-resource metadata: yes (resource https://mcp.linear.app/mcp)
//     authorization server: https://mcp.linear.app
//     authorization_endpoint is https: true
//     registration_endpoint (dynamic registration): yes
//     token_endpoint_auth_methods_supported: ["client_secret_basic","client_secret_post","none"]
//     public client ('none') allowed: true
//     code_challenge_methods_supported: ["S256"]
//     grant_types_supported: ["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:jwt-bearer"]
//     scopes_supported: ["read","write"]
//     client_id_metadata_document_supported: true
// Both advertise dynamic registration, public clients and S256 PKCE, so
// neither needs the Sign-in app. Redirect acceptance is untested: the
// redirect host stays 127.0.0.1.
import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';

const SERVERS = ['https://mcp.notion.com/mcp', 'https://mcp.linear.app/mcp'];

/** A fetch that only reads: anything but GET is refused before it leaves the machine. */
async function getOnly(url, init = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') throw new Error(`oauth-probe refuses ${method} ${url}: it only reads public metadata.`);
  return fetch(url, { ...init, method: 'GET', signal: AbortSignal.timeout(15_000) });
}

for (const server of SERVERS) {
  try {
    const info = await discoverOAuthServerInfo(server, { fetchFn: getOnly });
    const m = info.authorizationServerMetadata;
    console.log(`${server}`);
    console.log(`  protected-resource metadata: ${info.resourceMetadata ? `yes (resource ${info.resourceMetadata.resource})` : 'no'}`);
    console.log(`  authorization server: ${info.authorizationServerUrl}`);
    if (!m) {
      console.log('  authorization-server metadata: not found');
      continue;
    }
    console.log(`  authorization_endpoint is https: ${new URL(m.authorization_endpoint).protocol === 'https:'}`);
    console.log(`  registration_endpoint (dynamic registration): ${m.registration_endpoint ? 'yes' : 'no'}`);
    console.log(`  token_endpoint_auth_methods_supported: ${JSON.stringify(m.token_endpoint_auth_methods_supported ?? null)}`);
    console.log(`  public client ('none') allowed: ${(m.token_endpoint_auth_methods_supported ?? []).includes('none')}`);
    console.log(`  code_challenge_methods_supported: ${JSON.stringify(m.code_challenge_methods_supported ?? null)}`);
    console.log(`  grant_types_supported: ${JSON.stringify(m.grant_types_supported ?? null)}`);
    console.log(`  scopes_supported: ${JSON.stringify(info.resourceMetadata?.scopes_supported ?? m.scopes_supported ?? null)}`);
    console.log(`  client_id_metadata_document_supported: ${m.client_id_metadata_document_supported === true}`);
  } catch (err) {
    console.log(`${server}\n  probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
