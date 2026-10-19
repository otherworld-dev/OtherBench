import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { normaliseHost } from '@otherbench/core/domain/browser-hosts.js';
import type { ModelParams, Profile, ToolPolicy } from '@otherbench/core/types/config.js';
import { sweepOrphanedBlobs } from '@otherbench/store-sqlite/blob-gc.js';
import type { Container } from '../container.js';
import { optionalBoolean, optionalNullableString, optionalStringArray, parseSandboxHosts, requireNonEmptyString } from '../validation.js';
import { clearProjectDefaultProfile } from './projects.js';
import { clearMemoryProfile } from './settings.js';

const DEFAULT_TOOL_POLICY: ToolPolicy = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' };

interface ProfileBody {
  name?: unknown;
  description?: unknown;
  colour?: unknown;
  connectionId?: unknown;
  modelId?: unknown;
  systemPrompt?: unknown;
  params?: unknown;
  toolPolicy?: unknown;
  isDefault?: unknown;
  useGlobalMemory?: unknown;
  archivedAt?: unknown;
}

function parseParams(value: unknown): ModelParams {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HTTPException(400, { message: '"params" must be an object.' });
  }
  // ModelParams' fields are all optional numbers; trust the shape rather
  // than re-deriving a bespoke schema for four passthrough numeric knobs.
  return value as ModelParams;
}

const MAX_BLOCKED_HOSTS = 200;

/** A hostname: dot-separated labels of letters, digits and hyphens (any script: an IDN is stored as its punycode). */
const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?`;
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`, 'u');
/** An IP literal's characters: IPv4 dotted, or IPv6 (with or without brackets, at least one colon). */
const IPV6_LITERAL = /^\[?[0-9a-f]*:[0-9a-f:.]*\]?$/i;

/**
 * The browser's blocked sites (spec 2026-10-12-model-browser-design §3): each
 * entry must be a bare hostname or IP literal, stored in the canonical form the
 * broker and the proxy compare. A leading "*." is dropped (subdomains are
 * blocked anyway); any other `*`, a port, scheme, path, empty label or leading
 * or trailing dot is refused, naming the entry as typed.
 */
function parseBlockedHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new HTTPException(400, { message: '"toolPolicy.browserBlockedHosts" must be a list of website names.' });
  }
  if (value.length > MAX_BLOCKED_HOSTS) {
    throw new HTTPException(400, { message: `"toolPolicy.browserBlockedHosts" can hold at most ${MAX_BLOCKED_HOSTS} sites.` });
  }
  const out: string[] = [];
  for (const raw of value as string[]) {
    const entry = raw.trim().replace(/^\*\./, '');
    const host = HOSTNAME.test(entry) || IPV6_LITERAL.test(entry) ? normaliseHost(entry) : null;
    if (host === null) throw new HTTPException(400, { message: `"${raw}" isn't a website name. Use a name like example.com, one per line.` });
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/**
 * Parses a `toolPolicy` body. Omitted fields fall back to `base`: the defaults
 * on POST, the profile's EXISTING policy on PATCH -- so a partial PATCH such as
 * `{"fs":"read"}` cannot silently reset `mcpServerIds` (an access-control list)
 * or any other field it did not mention. Validation is identical either way.
 */
function parseToolPolicy(value: unknown, base: ToolPolicy = DEFAULT_TOOL_POLICY): ToolPolicy {
  if (value === undefined) return base;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HTTPException(400, { message: '"toolPolicy" must be an object.' });
  }
  const v = value as Record<string, unknown>;
  const fs = v['fs'];
  if (fs !== undefined && fs !== 'off' && fs !== 'read' && fs !== 'readwrite') {
    throw new HTTPException(400, { message: '"toolPolicy.fs" must be one of: off, read, readwrite.' });
  }
  const approvalMode = v['approvalMode'];
  if (approvalMode !== undefined && approvalMode !== 'always_ask' && approvalMode !== 'ask_on_mutate') {
    throw new HTTPException(400, { message: '"toolPolicy.approvalMode" must be one of: always_ask, ask_on_mutate.' });
  }
  for (const key of ['agentWeb', 'agentMcp', 'agentUserSettings', 'artifacts', 'recall', 'subagents', 'browser', 'computer'] as const) {
    if (v[key] !== undefined && typeof v[key] !== 'boolean') {
      throw new HTTPException(400, { message: `"toolPolicy.${key}" must be a boolean.` });
    }
  }
  const shellRuns = v['shellRuns'];
  if (shellRuns !== undefined && shellRuns !== 'host' && shellRuns !== 'sandbox') {
    throw new HTTPException(400, { message: '"toolPolicy.shellRuns" must be one of: host, sandbox.' });
  }
  // null = back to the default allowlist (the key is dropped); omitted = keep the base's.
  const sandboxHosts = v['sandboxHosts'] === undefined ? base.sandboxHosts : v['sandboxHosts'] === null ? undefined : parseSandboxHosts(v['sandboxHosts']);
  return {
    fs: (fs as ToolPolicy['fs']) ?? base.fs,
    shell: typeof v['shell'] === 'boolean' ? v['shell'] : base.shell,
    // Every entry must be a string -- a non-string (e.g. `null`) survives
    // the old `Array.isArray` check unchanged and round-trips into storage,
    // where it defeats PermissionBroker's `mcpServerIds.length === 0`
    // fast-deny path (see permissions.ts) without ever matching a real
    // server id. `undefined` (the field omitted) still means "default to
    // the harmless empty policy", same as before.
    mcpServerIds: v['mcpServerIds'] === undefined ? base.mcpServerIds : optionalStringArray(v['mcpServerIds'], 'toolPolicy.mcpServerIds'),
    approvalMode: (approvalMode as ToolPolicy['approvalMode']) ?? base.approvalMode,
    ...(typeof v['agentWeb'] === 'boolean' ? { agentWeb: v['agentWeb'] } : base.agentWeb !== undefined ? { agentWeb: base.agentWeb } : {}),
    ...(typeof v['agentMcp'] === 'boolean' ? { agentMcp: v['agentMcp'] } : base.agentMcp !== undefined ? { agentMcp: base.agentMcp } : {}),
    ...(typeof v['agentUserSettings'] === 'boolean' ? { agentUserSettings: v['agentUserSettings'] } : base.agentUserSettings !== undefined ? { agentUserSettings: base.agentUserSettings } : {}),
    ...(typeof v['artifacts'] === 'boolean' ? { artifacts: v['artifacts'] } : base.artifacts !== undefined ? { artifacts: base.artifacts } : {}),
    ...(typeof v['recall'] === 'boolean' ? { recall: v['recall'] } : base.recall !== undefined ? { recall: base.recall } : {}),
    ...(shellRuns !== undefined ? { shellRuns: shellRuns as ToolPolicy['shellRuns'] } : base.shellRuns !== undefined ? { shellRuns: base.shellRuns } : {}),
    ...(sandboxHosts !== undefined ? { sandboxHosts } : {}),
    ...(typeof v['subagents'] === 'boolean' ? { subagents: v['subagents'] } : base.subagents !== undefined ? { subagents: base.subagents } : {}),
    ...(typeof v['browser'] === 'boolean' ? { browser: v['browser'] } : base.browser !== undefined ? { browser: base.browser } : {}),
    // Computer use (spec 2026-10-12-computer-use-design): off unless a profile turns it on, so it is only ever stored when it was set.
    ...(typeof v['computer'] === 'boolean' ? { computer: v['computer'] } : base.computer !== undefined ? { computer: base.computer } : {}),
    ...(v['browserBlockedHosts'] !== undefined
      ? { browserBlockedHosts: parseBlockedHosts(v['browserBlockedHosts']) }
      : base.browserBlockedHosts !== undefined
        ? { browserBlockedHosts: base.browserBlockedHosts }
        : {}),
  };
}

function getProfileOrThrow(container: Container, id: string): Profile {
  const profile = container.store.profiles.get(id);
  if (!profile) throw new HTTPException(404, { message: `Profile "${id}" not found.` });
  return profile;
}

export function profilesRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(container.store.profiles.list()));

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ProfileBody;
    const created = container.store.profiles.create({
      id: randomUUID(),
      name: requireNonEmptyString(body.name, 'name'),
      description: optionalNullableString(body.description, 'description') ?? null,
      colour: optionalNullableString(body.colour, 'colour') ?? null,
      connectionId: requireNonEmptyString(body.connectionId, 'connectionId'),
      modelId: requireNonEmptyString(body.modelId, 'modelId'),
      systemPrompt: optionalNullableString(body.systemPrompt, 'systemPrompt') ?? null,
      params: parseParams(body.params),
      toolPolicy: parseToolPolicy(body.toolPolicy),
      isDefault: optionalBoolean(body.isDefault, 'isDefault', false),
      useGlobalMemory: optionalBoolean(body.useGlobalMemory, 'useGlobalMemory', true),
      archivedAt: null,
    });
    return c.json(created, 201);
  });

  app.get('/:id', (c) => c.json(getProfileOrThrow(container, c.req.param('id'))));

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getProfileOrThrow(container, id);
    const body = (await c.req.json().catch(() => ({}))) as ProfileBody;

    const patch: Partial<Omit<Profile, 'id'>> = {};
    if (body.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
    if (body.description !== undefined) patch.description = optionalNullableString(body.description, 'description') ?? null;
    if (body.colour !== undefined) patch.colour = optionalNullableString(body.colour, 'colour') ?? null;
    if (body.connectionId !== undefined) patch.connectionId = requireNonEmptyString(body.connectionId, 'connectionId');
    if (body.modelId !== undefined) patch.modelId = requireNonEmptyString(body.modelId, 'modelId');
    if (body.systemPrompt !== undefined) patch.systemPrompt = optionalNullableString(body.systemPrompt, 'systemPrompt') ?? null;
    if (body.params !== undefined) patch.params = parseParams(body.params);
    if (body.toolPolicy !== undefined) patch.toolPolicy = parseToolPolicy(body.toolPolicy, existing.toolPolicy);
    if (body.isDefault !== undefined) patch.isDefault = optionalBoolean(body.isDefault, 'isDefault', false);
    if (body.useGlobalMemory !== undefined) patch.useGlobalMemory = optionalBoolean(body.useGlobalMemory, 'useGlobalMemory', true);
    if (body.archivedAt !== undefined) {
      patch.archivedAt = body.archivedAt === null ? null : Number(body.archivedAt);
    }

    const updated = container.store.profiles.update(id, patch);
    // Computer use turned off on this profile: the chat on it that holds the computer (in control, or its
    // start dialog up) is stopped as by the banner's Stop. Its session ends and its replies are cancelled,
    // so a reply already running can't carry on with a tool the profile no longer allows.
    if (updated.toolPolicy.computer !== true) {
      const holder = container.computer?.holder() ?? null;
      if (holder !== null && container.store.chats.get(holder)?.profileId === id) await container.computer?.stop(holder);
    }
    // Spec section 5: an archived profile stops being any project's default.
    if (updated.archivedAt !== null) {
      clearProjectDefaultProfile(container.store, id);
      clearMemoryProfile(container.store, id);
    }
    return c.json(updated);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    getProfileOrThrow(container, id);
    // Its chats go with it (ON DELETE CASCADE): so do their sandboxes.
    const chatIds = container.store.chats.list().filter((chat) => chat.profileId === id).map((chat) => chat.id);
    container.store.profiles.delete(id);
    clearMemoryProfile(container.store, id);
    // Best effort, and before the sweep below, which can fail the request on purpose.
    for (const chatId of chatIds) {
      await container.sandbox?.release(chatId).catch((err: unknown) => console.error(`[otherbench-server] couldn't release the sandbox of chat ${chatId}:`, err));
    }
    // Its chats went with it, inside the database. One of them may be in control of the computer:
    // its session ends and its reply is cancelled (spec 2026-10-12-computer-use-design section 1).
    await container.computer?.endIfChatGone();
    // Nor do their Claude Code processes and background helpers keep running.
    const goneChats = new Set(chatIds);
    container.engine.closeChats?.((chatId) => goneChats.has(chatId));
    // Deleting a profile cascades its chats away (ON DELETE CASCADE), which
    // in turn cascades THEIR attachment rows away -- sweep for any blob
    // orphaned as a result. Filesystem-level failures are swallowed (see
    // sweepOrphanedBlobs's own doc) and can't turn this into a failed
    // request; a programming/wiring error is NOT swallowed and surfaces as
    // a 500 on purpose.
    await sweepOrphanedBlobs(container.store, container.blobStore);
    return c.body(null, 204);
  });

  return app;
}
