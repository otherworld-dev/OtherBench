import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ApprovalChoice } from '@grunt/core/ports/tool-provider.js';
import type { Grant, McpServer } from '@grunt/core/ports/store.js';
import type { Container } from '../container.js';
import { optionalBoolean, optionalNullableString, optionalStringHeadersRecord, requireNonEmptyString } from '../validation.js';

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

function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new HTTPException(400, { message: `"${field}" must be an array of strings.` });
  }
  return value;
}

function parseEnv(value: unknown): Record<string, string> {
  return optionalStringHeadersRecord(value, 'env');
}

function getMcpServerOrThrow(container: Container, id: string): McpServer {
  const row = container.store.mcpServers.get(id);
  if (!row) throw new HTTPException(404, { message: `MCP server "${id}" not found.` });
  return row;
}

/** Writes each header value to SecretStore under a fresh per-header ref and returns the resulting `headerRefs` map. Existing refs for headers no longer present are left orphaned (harmless: SecretStore has no listing/GC surface here, same accepted tradeoff Connection.secretRef already has on delete of individual headers, as opposed to the whole connection). */
async function storeHeaderSecrets(container: Container, serverId: string, headers: Record<string, string>): Promise<Record<string, string>> {
  const headerRefs: Record<string, string> = {};
  for (const [headerName, value] of Object.entries(headers)) {
    const ref = `mcp:${serverId}:${headerName}`;
    await container.secrets.set(ref, value);
    headerRefs[headerName] = ref;
  }
  return headerRefs;
}

async function deleteHeaderSecrets(container: Container, row: McpServer): Promise<void> {
  await Promise.all(Object.values(row.headerRefs).map((ref) => container.secrets.delete(ref)));
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

  app.post('/mcp-servers', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as McpServerBody;
    const name = requireNonEmptyString(body.name, 'name');
    const transport = parseTransport(body.transport);
    const headers = optionalStringHeadersRecord(body.headers, 'headers');
    const id = randomUUID();
    const headerRefs = await storeHeaderSecrets(container, id, headers);

    const created = container.store.mcpServers.create({
      id,
      name,
      transport,
      command: transport === 'stdio' ? (optionalNullableString(body.command, 'command') ?? null) : null,
      args: transport === 'stdio' ? parseStringArray(body.args, 'args') : [],
      env: transport === 'stdio' ? parseEnv(body.env) : {},
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
    if (body.args !== undefined) patch.args = parseStringArray(body.args, 'args');
    if (body.env !== undefined) patch.env = parseEnv(body.env);
    if (body.url !== undefined) patch.url = optionalNullableString(body.url, 'url') ?? null;
    if (body.enabled !== undefined) patch.enabled = optionalBoolean(body.enabled, 'enabled', existing.enabled);
    if (body.headers !== undefined) {
      await deleteHeaderSecrets(container, existing);
      patch.headerRefs = await storeHeaderSecrets(container, id, optionalStringHeadersRecord(body.headers, 'headers'));
    }

    const updated = container.store.mcpServers.update(id, patch);
    await container.mcpManager.sync();
    return c.json(updated);
  });

  app.delete('/mcp-servers/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getMcpServerOrThrow(container, id);
    await deleteHeaderSecrets(container, existing);
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
    if (!container.store.chats.get(chatId)) throw new HTTPException(404, { message: `Chat "${chatId}" not found.` });
    // Chat-scoped grants for THIS chat, plus every global ('always', chatId:
    // null) grant -- matches exactly what PermissionBroker.findMatchingGrant
    // considers eligible for a call in this chat (see permissions.ts), so
    // this view never omits a grant that is actually in effect here.
    const chatScoped = container.store.grants.list(chatId);
    const alwaysScoped = container.store.grants.list().filter((g) => g.chatId === null);
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
