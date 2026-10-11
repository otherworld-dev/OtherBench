import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ApprovalChoice } from '@grunt/core/ports/tool-provider.js';
import type { Grant, McpServer } from '@grunt/core/ports/store.js';
import type { Container } from '../container.js';
import { ClaudeDesktopConfigError, claudeDesktopConfigPath, readClaudeDesktopServers } from '../mcp-import.js';
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

export function parseApprovalChoice(body: ApprovalBody): ApprovalChoice {
  const choice = body.choice;
  if (choice === 'deny') return { choice: 'deny' };
  if (choice === 'once') return { choice: 'once' };
  if (choice === 'chat') return { choice: 'chat' };
  if (choice === 'always') return { choice: 'always', constraint: parseConstraint(body.constraint) };
  throw new HTTPException(400, { message: '"choice" must be one of: deny, once, chat, always.' });
}

// ---------------------------------------------------------------------------

/** A new MCP server's fields, already parsed: shared by `POST /mcp-servers` and the Claude Desktop import. */
interface NewMcpServerInput {
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
}

/** Creates the server row, its env and header values going into SecretStore (only the refs are stored). Doesn't sync the manager. */
async function createMcpServer(container: Container, input: NewMcpServerInput): Promise<McpServer> {
  const id = randomUUID();
  const envRefs = input.transport === 'stdio' ? await storeMcpSecrets(container, id, 'env', input.env) : {};
  const headerRefs = await storeMcpSecrets(container, id, 'header', input.headers);
  return container.store.mcpServers.create({
    id,
    name: input.name,
    transport: input.transport,
    command: input.transport === 'stdio' ? input.command : null,
    args: input.transport === 'stdio' ? input.args : [],
    envRefs,
    url: input.transport === 'http' ? input.url : null,
    headerRefs,
    enabled: input.enabled,
    status: 'unknown',
    toolsCache: null,
  });
}

/** Claude Desktop's servers, or a 400 when its config isn't valid JSON. */
async function claudeDesktopServers(path: string) {
  try {
    return await readClaudeDesktopServers(path);
  } catch (err) {
    if (err instanceof ClaudeDesktopConfigError) throw new HTTPException(400, { message: err.message });
    throw err;
  }
}

export function toolsRoutes(container: Container): Hono {
  const app = new Hono();

  // Import from Claude Desktop (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §3).
  // Only names, commands, URLs and the NAMES of env vars and headers go back:
  // their values stay on the server and go straight into SecretStore on import.
  app.get('/mcp-servers/import/claude-desktop', async (c) => {
    const path = claudeDesktopConfigPath();
    const read = await claudeDesktopServers(path);
    if (!read.found) return c.json({ path, found: false, servers: [] });
    const existing = new Set(container.store.mcpServers.list().map((r) => r.name));
    return c.json({
      path,
      found: true,
      servers: read.servers.map((s) => ({
        name: s.name,
        transport: s.transport,
        command: s.command,
        args: s.args,
        url: s.url,
        envNames: Object.keys(s.env),
        headerNames: Object.keys(s.headers),
        exists: existing.has(s.name),
        supported: s.supported,
        ...(s.reason ? { reason: s.reason } : {}),
      })),
    });
  });

  app.post('/mcp-servers/import/claude-desktop', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { names?: unknown; profileIds?: unknown };
    if (!Array.isArray(body.names) || !body.names.every((n) => typeof n === 'string')) {
      throw new HTTPException(400, { message: '"names" must be a list of server names.' });
    }
    // The profiles to turn the imported servers on for, all checked before
    // anything is created so a bad id never leaves a half-done import.
    const profileIds = body.profileIds ?? [];
    if (!Array.isArray(profileIds) || !profileIds.every((id) => typeof id === 'string')) {
      throw new HTTPException(400, { message: '"profileIds" must be a list of profile ids.' });
    }
    const profiles = [...new Set(profileIds as string[])].map((id) => {
      const profile = container.store.profiles.get(id);
      if (!profile) throw new HTTPException(400, { message: `There is no profile "${id}".` });
      return profile;
    });
    const path = claudeDesktopConfigPath();
    const read = await claudeDesktopServers(path);
    if (!read.found) throw new HTTPException(404, { message: `Claude Desktop's config wasn't found at ${path}.` });
    const existing = new Set(container.store.mcpServers.list().map((r) => r.name));
    const imported: string[] = [];
    const importedIds: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const name of body.names as string[]) {
      const s = read.servers.find((x) => x.name === name);
      if (!s) skipped.push({ name, reason: "It isn't in Claude Desktop's config." });
      else if (existing.has(name)) skipped.push({ name, reason: `Grunt already has a server called "${name}".` });
      else if (!s.supported || !s.transport) skipped.push({ name, reason: s.reason ?? "Grunt can't use it." });
      else {
        const created = await createMcpServer(container, { name, transport: s.transport, command: s.command, args: s.args, env: s.env, url: s.url, headers: s.headers, enabled: true });
        existing.add(name);
        imported.push(name);
        importedIds.push(created.id);
      }
    }
    if (imported.length > 0) await container.mcpManager.sync();
    const updated =
      importedIds.length === 0
        ? []
        : profiles.map((p) =>
            container.store.profiles.update(p.id, {
              toolPolicy: { ...p.toolPolicy, mcpServerIds: [...p.toolPolicy.mcpServerIds, ...importedIds.filter((id) => !p.toolPolicy.mcpServerIds.includes(id))] },
            })
          );
    return c.json({ imported, skipped, profiles: updated });
  });

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
    const created = await createMcpServer(container, {
      name,
      transport,
      command: transport === 'stdio' ? (optionalNullableString(body.command, 'command') ?? null) : null,
      args: transport === 'stdio' ? optionalStringArray(body.args, 'args') : [],
      env,
      url: transport === 'http' ? (optionalNullableString(body.url, 'url') ?? null) : null,
      headers,
      enabled: optionalBoolean(body.enabled, 'enabled', true),
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
    // flipped back later. A transport is a MODE, not two independent field
    // sets: `env` only ever applies to the RESULTING transport being
    // `stdio`, `headers` only to it being `http` -- enforced below by
    // gating each on `newTransport`, not merely on whether the caller also
    // set `transport` in this same request. Without that gate, an explicit
    // `env`/`headers` in the very request that flips transport (e.g.
    // `{"transport":"http","env":{"LEFTOVER":"x"}}`) would still be applied
    // and store env refs on an http row -- meaningless, and not what a
    // transport switch's cleanup below is supposed to guarantee.
    const newTransport = patch.transport ?? existing.transport;
    const transportChanged = patch.transport !== undefined && patch.transport !== existing.transport;

    if (newTransport === 'stdio' && body.env !== undefined) {
      patch.envRefs = await applySecretPatch(container, id, 'env', existing.envRefs, optionalSecretPatchRecord(body.env, 'env'));
    } else if (transportChanged && newTransport === 'http') {
      await deleteSecretRefs(container, existing.envRefs);
      patch.envRefs = {};
    }
    if (newTransport === 'http' && body.headers !== undefined) {
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
