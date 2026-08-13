import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ApprovalChoice } from '@grunt/core/ports/tool-provider.js';
import type { Grant, McpServer } from '@grunt/core/ports/store.js';
import type { Container } from '../container.js';
import {
  optionalBoolean,
  optionalNonEmptySecretRecord,
  optionalNullableString,
  optionalSecretPatchRecord,
  optionalStringArray,
  requireNonEmptyString,
} from '../validation.js';

// ---------------------------------------------------------------------------
// MCP servers -- CRUD + live health + per-server refresh.
//
// `sync()` is called after every write (create/update/delete) so "connect on
// enable" (task 25/26 brief) takes effect on the very next request this
// route returns for, not on some later poll: McpServerManager has no
// standalone reactivity of its own (Store has no change-notification
// mechanism -- see McpServerManager's class doc), so the route IS the
// trigger.
// ---------------------------------------------------------------------------

interface McpServerBody {
  name?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  /**
   * Plaintext env VAR VALUES on the wire (e.g. `{"API_KEY": "sk-..."}`).
   * Never stored as-is: each is written to `SecretStore` and only the
   * resulting reference is persisted in `McpServer.envRefs`, the identical
   * treatment `headers` (below) gets -- a stdio server's environment is
   * exactly as likely to carry a credential as an HTTP server's headers.
   */
  env?: unknown;
  url?: unknown;
  /**
   * Plaintext header VALUES on the wire (e.g. `{"Authorization": "Bearer sk-..."}`).
   * Never stored as-is: each is written to `SecretStore` and only the
   * resulting reference is persisted in `McpServer.headerRefs`, mirroring
   * `Connection.secretRef` (see routes/connections.ts) -- the same
   * "API keys never in SQLite" discipline applied to MCP server auth headers.
   */
  headers?: unknown;
  enabled?: unknown;
}

function parseTransport(value: unknown): McpServer['transport'] {
  if (value !== 'stdio' && value !== 'http') {
    throw new HTTPException(400, { message: '"transport" must be "stdio" or "http".' });
  }
  return value;
}

function getMcpServerOrThrow(container: Container, id: string): McpServer {
  const row = container.store.mcpServers.get(id);
  if (!row) throw new HTTPException(404, { message: `MCP server "${id}" not found.` });
  return row;
}

/**
 * Writes each value in `values` to `SecretStore` under a fresh per-entry ref
 * and returns the resulting `{name: ref}` map -- shared by `env`->`envRefs`
 * and `headers`->`headerRefs`, distinguished only by `kind` in the ref's own
 * name (so an env var and a header happening to share a name on the SAME
 * server never collide on the same secret). Existing refs for entries no
 * longer present are left orphaned (harmless: SecretStore has no
 * listing/GC surface here, same accepted tradeoff `Connection.secretRef`
 * already has on delete of individual headers, as opposed to the whole
 * connection).
 */
async function storeMcpSecrets(
  container: Container,
  serverId: string,
  kind: 'env' | 'header',
  values: Record<string, string>
): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    const ref = `mcp:${serverId}:${kind}:${name}`;
    await container.secrets.set(ref, value);
    refs[name] = ref;
  }
  return refs;
}

/** Deletes every secret a `{name: ref}` map points at -- used on a transport switch (the now-irrelevant side's refs, see `applySecretPatch`'s call sites below), and via `deleteAllMcpSecrets` (both fields) on DELETE. */
async function deleteSecretRefs(container: Container, refs: Record<string, string>): Promise<void> {
  await Promise.all(Object.values(refs).map((ref) => container.secrets.delete(ref)));
}

async function deleteAllMcpSecrets(container: Container, row: McpServer): Promise<void> {
  await deleteSecretRefs(container, row.envRefs);
  await deleteSecretRefs(container, row.headerRefs);
}

/**
 * Applies a `PATCH /mcp-servers/:id` `env`/`headers` patch (parsed by
 * `optionalSecretPatchRecord`) against the server's existing `{name: ref}`
 * map, returning the new one. Per name in `patchValues`:
 *  - a string value REPLACES that name's secret (the ref is deterministic --
 *    `mcp:<serverId>:<kind>:<name>`, same formula as `storeMcpSecrets` -- so
 *    this is just overwriting whatever `SecretStore` entry that ref already
 *    names, same as before);
 *  - `null` KEEPS the existing ref (and the secret it points at) completely
 *    untouched -- no `SecretStore` write at all -- unless there was nothing
 *    to keep (the name has no existing ref), in which case it's a no-op.
 *
 * A name in `existingRefs` that `patchValues` doesn't mention at all is
 * deleted: "touching this field replaces the whole set" is unchanged --
 * `null` is the one way to opt a specific, unedited name back OUT of that
 * replacement instead of losing it.
 */
async function applySecretPatch(
  container: Container,
  serverId: string,
  kind: 'env' | 'header',
  existingRefs: Record<string, string>,
  patchValues: Record<string, string | null>
): Promise<Record<string, string>> {
  const newRefs: Record<string, string> = {};

  for (const [name, value] of Object.entries(patchValues)) {
    if (value === null) {
      const existingRef = existingRefs[name];
      if (existingRef !== undefined) newRefs[name] = existingRef;
      continue;
    }
    const ref = `mcp:${serverId}:${kind}:${name}`;
    await container.secrets.set(ref, value);
    newRefs[name] = ref;
  }

  const refsToDelete = Object.entries(existingRefs)
    .filter(([name]) => !(name in newRefs))
    .map(([, ref]) => ref);
  await Promise.all(refsToDelete.map((ref) => container.secrets.delete(ref)));

  return newRefs;
}

// ---------------------------------------------------------------------------
// Approvals -- the human-in-the-loop half of PermissionBroker's 'ask'
// decisions (task 26). The request itself streams to the client over the
// existing SSE channel (routes/turns.ts's GET .../stream) as an ordinary
// TurnEvent -- TurnRunner relays every ToolProvider.onApprovalEvent it sees,
// tagged with the request's own messageId, so no separate transport is
// needed here; this route is purely the answer path.
// ---------------------------------------------------------------------------

interface ApprovalBody {
  choice?: unknown;
  constraint?: unknown;
}

function parseConstraint(value: unknown): Grant['constraint'] {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HTTPException(400, { message: '"constraint" must be an object or null.' });
  }
  const v = value as Record<string, unknown>;
  const pathPrefix = v['pathPrefix'];
  const commandPrefix = v['commandPrefix'];
  const commandExact = v['commandExact'];
  if (pathPrefix !== undefined && typeof pathPrefix !== 'string') {
    throw new HTTPException(400, { message: '"constraint.pathPrefix" must be a string.' });
  }
  if (commandPrefix !== undefined && typeof commandPrefix !== 'string') {
    throw new HTTPException(400, { message: '"constraint.commandPrefix" must be a string.' });
  }
  if (commandExact !== undefined && typeof commandExact !== 'string') {
    throw new HTTPException(400, { message: '"constraint.commandExact" must be a string.' });
  }
  if (pathPrefix === undefined && commandPrefix === undefined && commandExact === undefined) return null;
  return {
    pathPrefix: pathPrefix as string | undefined,
    commandPrefix: commandPrefix as string | undefined,
    commandExact: commandExact as string | undefined,
  };
}

function parseApprovalChoice(body: ApprovalBody): ApprovalChoice {
  const choice = body.choice;
  if (choice === 'deny') return { choice: 'deny' };
  if (choice === 'once') return { choice: 'once' };
  if (choice === 'chat') return { choice: 'chat' };
  if (choice === 'always') return { choice: 'always', constraint: parseConstraint(body.constraint) };
  throw new HTTPException(400, { message: '"choice" must be one of: deny, once, chat, always.' });
}

// ---------------------------------------------------------------------------

export function toolsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/mcp-servers', (c) => c.json(container.mcpManager.health()));

  // Full config for ONE server (command/args/url/enabled/transport --
  // everything `health()` above omits because it's shaped for runtime
  // status, not editing). Mirrors `GET /connections/:id`: returns the
  // stored row including `envRefs`/`headerRefs` (reference ids, safe to
  // show), never the plaintext values those refs point at -- there is no
  // route anywhere that returns those, matching `Connection.secretRef`.
  app.get('/mcp-servers/:id', (c) => c.json(getMcpServerOrThrow(container, c.req.param('id'))));

  app.post('/mcp-servers', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as McpServerBody;
    const name = requireNonEmptyString(body.name, 'name');
    const transport = parseTransport(body.transport);
    const env = optionalNonEmptySecretRecord(body.env, 'env');
    const headers = optionalNonEmptySecretRecord(body.headers, 'headers');
    const id = randomUUID();
    const envRefs = transport === 'stdio' ? await storeMcpSecrets(container, id, 'env', env) : {};
    const headerRefs = await storeMcpSecrets(container, id, 'header', headers);

    const created = container.store.mcpServers.create({
      id,
      name,
      transport,
      command: transport === 'stdio' ? (optionalNullableString(body.command, 'command') ?? null) : null,
      args: transport === 'stdio' ? optionalStringArray(body.args, 'args') : [],
      envRefs,
      url: transport === 'http' ? (optionalNullableString(body.url, 'url') ?? null) : null,
      headerRefs,
      enabled: optionalBoolean(body.enabled, 'enabled', true),
      status: 'unknown',
      toolsCache: null,
    });
    await container.mcpManager.sync();
    return c.json(created, 201);
  });

  app.patch('/mcp-servers/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getMcpServerOrThrow(container, id);
    const body = (await c.req.json().catch(() => ({}))) as McpServerBody;

    const patch: Partial<Omit<McpServer, 'id'>> = {};
    if (body.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
    if (body.transport !== undefined) patch.transport = parseTransport(body.transport);
    if (body.command !== undefined) patch.command = optionalNullableString(body.command, 'command') ?? null;
    if (body.args !== undefined) patch.args = optionalStringArray(body.args, 'args');
    if (body.url !== undefined) patch.url = optionalNullableString(body.url, 'url') ?? null;
    if (body.enabled !== undefined) patch.enabled = optionalBoolean(body.enabled, 'enabled', existing.enabled);

    // A transport switch makes the OTHER transport's fields irrelevant --
    // `POST` never lets them exist together in the first place (only the
    // matching transport's fields are ever populated, see above), so a
    // PATCH that flips transport must clean up the side that no longer
    // applies rather than leaving it stale: `envRefs`/`headerRefs` orphaned
    // in `SecretStore` with nothing left pointing at them, or a `url`/
    // `command` that silently starts applying again if the transport is
    // flipped back later. Only touches a field the caller didn't ALSO set
    // explicitly in this same request -- an explicit value in the same
    // PATCH that just changed transport is respected, not clobbered.
    const newTransport = patch.transport ?? existing.transport;
    const transportChanged = patch.transport !== undefined && patch.transport !== existing.transport;

    if (body.env !== undefined) {
      patch.envRefs = await applySecretPatch(container, id, 'env', existing.envRefs, optionalSecretPatchRecord(body.env, 'env'));
    } else if (transportChanged && newTransport === 'http') {
      await deleteSecretRefs(container, existing.envRefs);
      patch.envRefs = {};
    }
    if (body.headers !== undefined) {
      patch.headerRefs = await applySecretPatch(container, id, 'header', existing.headerRefs, optionalSecretPatchRecord(body.headers, 'headers'));
    } else if (transportChanged && newTransport === 'stdio') {
      await deleteSecretRefs(container, existing.headerRefs);
      patch.headerRefs = {};
    }
    if (transportChanged && newTransport === 'stdio' && body.url === undefined) {
      patch.url = null;
    }
    if (transportChanged && newTransport === 'http') {
      if (body.command === undefined) patch.command = null;
      if (body.args === undefined) patch.args = [];
    }

    const updated = container.store.mcpServers.update(id, patch);
    await container.mcpManager.sync();
    return c.json(updated);
  });

  app.delete('/mcp-servers/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getMcpServerOrThrow(container, id);
    await deleteAllMcpSecrets(container, existing);
    container.store.mcpServers.delete(id);
    await container.mcpManager.sync();
    return c.body(null, 204);
  });

  app.post('/mcp-servers/:id/refresh', async (c) => {
    const id = c.req.param('id');
    getMcpServerOrThrow(container, id);
    await container.toolProvider.refreshMcp(id);
    return c.body(null, 204);
  });

  // --- grants (Inspector's "active grants" section) -------------------------

  app.get('/chats/:id/grants', (c) => {
    const chatId = c.req.param('id');
    const chat = container.store.chats.get(chatId);
    if (!chat) throw new HTTPException(404, { message: `Chat "${chatId}" not found.` });
    // Chat-scoped grants for THIS chat, plus every global ('always', chatId:
    // null) grant that this chat's PROFILE could actually match -- the same
    // two filters PermissionBroker.findMatchingGrant applies (see
    // permissions.ts: grants are profile-scoped, because tool permission is
    // a per-profile property). Listing a grant belonging to another profile
    // would show the user a permission that is not in effect here.
    const chatScoped = container.store.grants.list(chatId);
    const alwaysScoped = container.store.grants
      .list()
      .filter((g) => g.chatId === null && (g.profileId === null || g.profileId === chat.profileId));
    return c.json([...chatScoped, ...alwaysScoped]);
  });

  app.delete('/grants/:id', (c) => {
    const id = c.req.param('id');
    if (!container.store.grants.get(id)) throw new HTTPException(404, { message: `Grant "${id}" not found.` });
    container.store.grants.delete(id);
    return c.body(null, 204);
  });

  // --- audit trail ------------------------------------------------------------

  app.get('/chats/:id/audit', (c) => {
    const chatId = c.req.param('id');
    if (!container.store.chats.get(chatId)) throw new HTTPException(404, { message: `Chat "${chatId}" not found.` });
    return c.json(container.store.audit.list(chatId));
  });

  // --- approvals --------------------------------------------------------------

  app.post('/approvals/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as ApprovalBody;
    const choice = parseApprovalChoice(body);
    const resolved = container.toolProvider.resolveApproval(id, choice);
    if (!resolved) {
      throw new HTTPException(404, { message: `Approval request "${id}" is unknown or was already resolved.` });
    }
    return c.json({ resolved: true });
  });

  return app;
}
