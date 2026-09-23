import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DiscoveredModel } from '@grunt/core/ports/chat-engine.js';
import type { Connection, ConnectionKind, ModelInfo } from '@grunt/core/types/config.js';
import { classifyProviderError } from '@grunt/core/types/errors.js';
import type { ErrorKind } from '@grunt/core/types/messages.js';
import { sweepOrphanedBlobs } from '@grunt/store-sqlite/blob-gc.js';
import type { Container } from '../container.js';
import { optionalNullableString, optionalStringHeadersRecord, requireNonEmptyString } from '../validation.js';

const CONNECTION_KINDS: readonly ConnectionKind[] = ['anthropic', 'openai', 'openai_compatible', 'google', 'ollama', 'mock'];

interface ConnectionBody {
  name?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  extraHeaders?: unknown;
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
 * but are still handled defensively) is reported as 502: Grunt is acting as
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
      secretRef = `conn:${id}`;
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

    if ('apiKey' in body) {
      if (body.apiKey === null) {
        if (existing.secretRef) await container.secrets.delete(existing.secretRef);
        patch.secretRef = null;
      } else if (typeof body.apiKey === 'string' && body.apiKey.length > 0) {
        const ref = existing.secretRef ?? `conn:${id}`;
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
    container.store.connections.delete(id);
    // Deleting a connection cascades away its models/profiles/chats and, in
    // turn, THEIR attachment rows (ON DELETE CASCADE) -- sweep for any blob
    // orphaned as a result. Never throws; can't turn this delete into a
    // failed request.
    await sweepOrphanedBlobs(container.store, container.blobStore);
    return c.body(null, 204);
  });

  app.post('/:id/test', async (c) => {
    const id = c.req.param('id');
    const conn = getConnectionOrThrow(container, id);
    const apiKey = conn.secretRef ? await container.secrets.get(conn.secretRef) : null;
    const result = await container.engine.testConnection(conn, apiKey);
    container.store.connections.update(id, {
      status: result.ok ? 'ok' : 'error',
      statusMessage: result.message,
      checkedAt: Date.now(),
    });
    return c.json(result);
  });

  app.post('/:id/discover-models', async (c) => {
    const id = c.req.param('id');
    const conn = getConnectionOrThrow(container, id);
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
