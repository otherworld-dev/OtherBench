import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { defaultAvailability } from '@otherbench/core/domain/availability.js';
import { isGenerationKind } from '@otherbench/core/domain/media.js';
import { connectionSecretRef } from '@otherbench/core/domain/sync.js';
import type { ConnectionTestResult, DiscoveredModel } from '@otherbench/core/ports/chat-engine.js';
import type { MediaConnection } from '@otherbench/core/ports/media.js';
import type { Connection, ConnectionKind, ModelInfo } from '@otherbench/core/types/config.js';
import { classifyProviderError } from '@otherbench/core/types/errors.js';
import type { ErrorKind } from '@otherbench/core/types/messages.js';
import { sweepOrphanedBlobs } from '@otherbench/store-sqlite/blob-gc.js';
import { comfyCheckpoints } from '@otherbench/tools/media/comfyui.js';
import type { Container } from '../container.js';
import { backendOf, mediaConnectionOf } from '../media.js';
import { optionalNullableString, optionalStringHeadersRecord, requireNonEmptyString } from '../validation.js';

const CONNECTION_KINDS: readonly ConnectionKind[] = ['anthropic', 'openai', 'openai_compatible', 'google', 'ollama', 'claude_code', 'mock', 'comfyui', 'a1111', 'openai_images'];

interface ConnectionBody {
  name?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  extraHeaders?: unknown;
  availability?: unknown;
  syncSecret?: unknown;
}

/** 'anywhere' or a known machine: this one or a paired one. */
function parseAvailability(container: Container, value: unknown): string {
  if (value === 'anywhere') return value;
  const self = container.store.nodes.self().id;
  if (typeof value === 'string' && (value === self || container.store.peers.get(value))) return value;
  throw new HTTPException(400, { message: '"availability" must be "anywhere" or the id of this or a paired machine.' });
}

function parseSyncSecret(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new HTTPException(400, { message: '"syncSecret" must be true or false.' });
  return value;
}

function parseKind(value: unknown): ConnectionKind {
  if (typeof value !== 'string' || !CONNECTION_KINDS.includes(value as ConnectionKind)) {
    throw new HTTPException(400, { message: `"kind" must be one of: ${CONNECTION_KINDS.join(', ')}.` });
  }
  return value as ConnectionKind;
}

function getConnectionOrThrow(container: Container, id: string): Connection {
  const conn = container.store.connections.get(id);
  if (!conn) throw new HTTPException(404, { message: `Connection "${id}" not found.` });
  return conn;
}

/**
 * `openai_compatible` (unlike `ollama`, which falls back to a default local
 * URL) has no default host to talk to -- `buildProvider`
 * (packages/engine-aisdk/src/registry.ts) always throws `ConfigError` for
 * one with no `baseUrl`, which made every `/test`, `/discover-models`, and
 * real turn against such a connection fail. Rejected at creation so a new
 * connection can't be saved into a state that can only ever fail; existing
 * rows saved before this check existed are untouched (validation only ever
 * runs against a write) and are still handled gracefully -- `testConnection`
 * now classifies that same `ConfigError` into `{ok: false, message}` instead
 * of throwing (see `AiSdkChatEngine.testConnection`).
 */
function requireBaseUrlIfOpenaiCompatible(kind: ConnectionKind, baseUrl: string | null | undefined): void {
  // Generation connections have no default host either, and nothing to auto-detect.
  if (isGenerationKind(kind) && !baseUrl) {
    throw new HTTPException(400, { message: `"baseUrl" is required for a "${kind}" connection: it has no default host to talk to.` });
  }
  if (kind === 'openai_compatible' && !baseUrl) {
    throw new HTTPException(400, {
      message: '"baseUrl" is required for an "openai_compatible" connection: it has no default host to talk to.',
    });
  }
}

/**
 * Maps a `classifyProviderError` kind to an HTTP status a client can act on,
 * mirroring `/test` (which already turns the same underlying failure into a
 * helpful `{ok: false, message}` instead of letting it throw). `auth` is a
 * 400: the POST itself was fine, but this connection's *stored* credential
 * is wrong, retrying it verbatim will never succeed, and the client's actual
 * next step is to rotate the key via `PATCH .../:id` -- not retry, so 401/403
 * (which would read as *this* API's own bearer-token auth failing, per
 * app.ts's gate) would be misleading. `rate_limit` passes the provider's own
 * 429 straight through since it is the one kind worth a client
 * retry-with-backoff. Everything else (network failures, upstream 5xxs, and
 * kinds that don't really apply to a bare "list models" call --
 * content_filter/context_overflow/capability are turn-completion concepts --
 * but are still handled defensively) is reported as 502: OtherBench is acting as
 * a gateway to the provider here, and it is the provider's response that
 * failed, not this request.
 */
function statusForClassifiedError(kind: ErrorKind): 400 | 429 | 502 {
  if (kind === 'auth') return 400;
  if (kind === 'rate_limit') return 429;
  return 502;
}

/**
 * Reconciles freshly `DiscoveredModel[]` results against what is already
 * stored for this connection: a model id never seen before is inserted as
 * `source: 'discovered'`; one already stored with `source: 'discovered'` is
 * refreshed in place (same row, same id) rather than duplicated; one a user
 * added by hand OR has ever edited and saved via the Models panel
 * (`source: 'manual'` -- see the promotion in routes/models.ts's PATCH
 * handler) is left completely untouched, so re-running discovery can never
 * clobber a manual edit. This matters beyond the "added by hand" case: for
 * a connection kind whose discovery reports real values (currently only
 * Ollama, via `AiSdkChatEngine.seedOllamaCapabilities`), a `discovered` row
 * left unedited keeps tracking the provider on every re-run -- only an
 * edited row opts out.
 */
function upsertDiscoveredModels(container: Container, connectionId: string, discovered: DiscoveredModel[]): ModelInfo[] {
  const existingByModelId = new Map(container.store.models.list(connectionId).map((m) => [m.modelId, m]));
  const result: ModelInfo[] = [];

  for (const d of discovered) {
    const current = existingByModelId.get(d.modelId);
    if (!current) {
      result.push(
        container.store.models.create({
          id: randomUUID(),
          connectionId,
          modelId: d.modelId,
          displayName: d.displayName,
          source: 'discovered',
          supportsVision: d.supportsVision ?? false,
          supportsTools: d.supportsTools ?? false,
          supportsReasoning: false,
          contextWindow: d.contextWindow,
          maxOutput: null,
          priceInPer1m: null,
          priceOutPer1m: null,
          priceCachedPer1m: null,
          currency: 'USD',
        })
      );
    } else if (current.source === 'discovered') {
      result.push(
        container.store.models.update(current.id, {
          displayName: d.displayName,
          supportsVision: d.supportsVision ?? current.supportsVision,
          supportsTools: d.supportsTools ?? current.supportsTools,
          contextWindow: d.contextWindow ?? current.contextWindow,
        })
      );
    } else {
      result.push(current);
    }
  }

  return result;
}

/** How long a generation connection's Test or model listing may take. */
const MEDIA_TIMEOUT_MS = 15_000;

/** The request's signal with the time limit added, and the words for a failure under it. */
function mediaCall(conn: Connection, request: AbortSignal): { signal: AbortSignal; failure: (err: unknown) => string } {
  const timeout = AbortSignal.timeout(MEDIA_TIMEOUT_MS);
  return {
    signal: AbortSignal.any([request, timeout]),
    failure: (err) =>
      timeout.aborted ? `${conn.baseUrl ?? conn.name} didn't answer within ${MEDIA_TIMEOUT_MS / 1000} seconds.` : (err instanceof Error ? err.message : String(err)).slice(0, 500),
  };
}

/** A generation connection's Test: its backend's own check, reported as a chat test's is. */
async function testGeneration(container: Container, conn: Connection, request: AbortSignal): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  const { signal, failure } = mediaCall(conn, request);
  try {
    await backendOf(container.store, await mediaConnectionOf(container, conn)).test(signal);
    return { ok: true, message: 'Connected.', latencyMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, message: failure(err), latencyMs: Date.now() - startedAt };
  }
}

export function connectionsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(container.store.connections.list()));

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ConnectionBody;
    const name = requireNonEmptyString(body.name, 'name');
    const kind = parseKind(body.kind);
    const baseUrl = optionalNullableString(body.baseUrl, 'baseUrl');
    const extraHeaders = optionalStringHeadersRecord(body.extraHeaders, 'extraHeaders');
    requireBaseUrlIfOpenaiCompatible(kind, baseUrl);

    const id = randomUUID();
    let secretRef: string | null = null;
    if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
      secretRef = connectionSecretRef(id);
      await container.secrets.set(secretRef, body.apiKey);
    } else if (body.apiKey !== undefined && body.apiKey !== null) {
      throw new HTTPException(400, { message: '"apiKey" must be a non-empty string, null, or omitted.' });
    }

    const created = container.store.connections.create({
      id,
      name,
      kind,
      baseUrl: baseUrl ?? null,
      secretRef,
      extraHeaders,
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
      // A loopback address is only reachable on this machine (v2 spec §5), unless the caller says otherwise.
      availability: body.availability !== undefined ? parseAvailability(container, body.availability) : defaultAvailability(kind, baseUrl ?? null, container.store.nodes.self().id),
      syncSecret: body.syncSecret !== undefined ? parseSyncSecret(body.syncSecret) : true,
    });
    return c.json(created, 201);
  });

  app.get('/:id', (c) => c.json(getConnectionOrThrow(container, c.req.param('id'))));

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getConnectionOrThrow(container, id);
    const body = (await c.req.json().catch(() => ({}))) as ConnectionBody;

    const patch: Partial<Omit<Connection, 'id'>> = {};
    if (body.name !== undefined) patch.name = requireNonEmptyString(body.name, 'name');
    if (body.kind !== undefined) patch.kind = parseKind(body.kind);
    if (body.baseUrl !== undefined) patch.baseUrl = optionalNullableString(body.baseUrl, 'baseUrl') ?? null;
    if (body.extraHeaders !== undefined) patch.extraHeaders = optionalStringHeadersRecord(body.extraHeaders, 'extraHeaders');

    // Only re-validated when the patch actually touches `kind` or `baseUrl`
    // -- a row already saved with kind: openai_compatible and no baseUrl
    // (from before this check existed, or restored from an older backup)
    // must stay editable for its other fields rather than being locked out
    // until the caller also supplies a baseUrl it didn't ask to change.
    if (patch.kind !== undefined || patch.baseUrl !== undefined) {
      requireBaseUrlIfOpenaiCompatible(patch.kind ?? existing.kind, patch.baseUrl !== undefined ? patch.baseUrl : existing.baseUrl);
    }
    if (body.availability !== undefined) {
      patch.availability = parseAvailability(container, body.availability);
    } else if (patch.baseUrl !== undefined || patch.kind !== undefined) {
      // Re-pointed: where it can be used follows the new address.
      patch.availability = defaultAvailability(patch.kind ?? existing.kind, patch.baseUrl !== undefined ? patch.baseUrl : existing.baseUrl, container.store.nodes.self().id);
    }
    if (body.syncSecret !== undefined) patch.syncSecret = parseSyncSecret(body.syncSecret);

    if ('apiKey' in body) {
      if (body.apiKey === null) {
        if (existing.secretRef) await container.secrets.delete(existing.secretRef);
        patch.secretRef = null;
      } else if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
        const ref = existing.secretRef ?? connectionSecretRef(id);
        await container.secrets.set(ref, body.apiKey);
        patch.secretRef = ref;
      } else {
        throw new HTTPException(400, { message: '"apiKey" must be a non-empty string or null.' });
      }
    }

    const updated = container.store.connections.update(id, patch);
    return c.json(updated);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = getConnectionOrThrow(container, id);
    if (existing.secretRef) await container.secrets.delete(existing.secretRef);
    // Its profiles' chats go with it (ON DELETE CASCADE): so do their sandboxes.
    const profileIds = new Set(container.store.profiles.list().filter((p) => p.connectionId === id).map((p) => p.id));
    const chatIds = container.store.chats.list().filter((chat) => profileIds.has(chat.profileId)).map((chat) => chat.id);
    container.store.connections.delete(id);
    // Best effort, and before the sweep below, which can fail the request on purpose.
    for (const chatId of chatIds) {
      await container.sandbox?.release(chatId).catch((err: unknown) => console.error(`[otherbench-server] couldn't release the sandbox of chat ${chatId}:`, err));
    }
    // Its profiles and their chats went with it, inside the database. One of those chats may be in
    // control of the computer: its session ends and its reply is cancelled (spec 2026-10-12-computer-use-design section 1).
    await container.computer?.endIfChatGone();
    // Nor do their Claude Code processes and background helpers keep running.
    const goneChats = new Set(chatIds);
    container.engine.closeChats?.((chatId) => goneChats.has(chatId));
    // Deleting a connection cascades away its models/profiles/chats and, in
    // turn, THEIR attachment rows (ON DELETE CASCADE) -- sweep for any blob
    // orphaned as a result. Filesystem-level failures are swallowed (see
    // sweepOrphanedBlobs's own doc) and can't turn this into a failed
    // request; a programming/wiring error is NOT swallowed and surfaces as
    // a 500 on purpose.
    await sweepOrphanedBlobs(container.store, container.blobStore);
    return c.body(null, 204);
  });

  app.post('/:id/test', async (c) => {
    const id = c.req.param('id');
    const conn = getConnectionOrThrow(container, id);
    // A generation connection is tested by its backend, never a chat engine.
    let result: ConnectionTestResult;
    if (isGenerationKind(conn.kind)) {
      result = await testGeneration(container, conn, c.req.raw.signal);
    } else {
      const apiKey = conn.secretRef ? await container.secrets.get(conn.secretRef) : null;
      result = await container.engine.testConnection(conn, apiKey);
    }
    container.store.connections.update(id, {
      status: result.ok ? 'ok' : 'error',
      statusMessage: result.message,
      checkedAt: Date.now(),
    });
    return c.json(result);
  });

  // The generation pickers: a generation connection's models or workflows, and for ComfyUI the model files it has.
  app.get('/:id/media-models', async (c) => {
    const conn = getConnectionOrThrow(container, c.req.param('id'));
    if (!isGenerationKind(conn.kind)) throw new HTTPException(400, { message: 'Only a generation connection has generation models.' });
    const media = c.req.query('media');
    if (media !== 'image' && media !== 'video') throw new HTTPException(400, { message: '"media" must be "image" or "video".' });
    const { signal, failure } = mediaCall(conn, c.req.raw.signal);
    let models: { id: string; label: string }[];
    let mc: MediaConnection;
    try {
      mc = await mediaConnectionOf(container, conn);
      models = await backendOf(container.store, mc).listModels(media, signal);
    } catch (err) {
      throw new HTTPException(502, { message: failure(err) });
    }
    if (mc.kind !== 'comfyui') return c.json({ models, checkpoints: [] });
    // The workflows are OtherBench's own: they are listed even when ComfyUI can't say which files it has.
    try {
      return c.json({ models, checkpoints: await comfyCheckpoints(mc, signal, media) });
    } catch (err) {
      return c.json({ models, checkpoints: [], checkpointsError: failure(err) });
    }
  });

  app.post('/:id/discover-models', async (c) => {
    const id = c.req.param('id');
    const conn = getConnectionOrThrow(container, id);
    if (isGenerationKind(conn.kind)) throw new HTTPException(400, { message: 'A generation connection has no chat models to discover.' });
    const apiKey = conn.secretRef ? await container.secrets.get(conn.secretRef) : null;

    let discovered: DiscoveredModel[];
    try {
      discovered = await container.engine.listModels(conn, apiKey);
    } catch (err) {
      // AiSdkChatEngine.listRealModels throws (APICallError on any non-2xx
      // response, a raw network error on a connection failure) rather than
      // returning a result object -- unlike testConnection, which already
      // catches and reports {ok: false, message}. Without this, a bad API
      // key or unreachable host surfaced here as an opaque 500 with a stack
      // trace to stderr (app.ts's onError catch-all), instead of a response
      // the client could act on.
      const classified = classifyProviderError(err);
      return c.json(classified, statusForClassifiedError(classified.kind));
    }

    const saved = upsertDiscoveredModels(container, id, discovered);
    return c.json(saved);
  });

  return app;
}
