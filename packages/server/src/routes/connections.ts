import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DiscoveredModel } from '@grunt/core/ports/chat-engine.js';
import type { Connection, ConnectionKind, ModelInfo } from '@grunt/core/types/config.js';
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
 * Reconciles freshly `DiscoveredModel[]` results against what is already
 * stored for this connection: a model id never seen before is inserted as
 * `source: 'discovered'`; one already stored with `source: 'discovered'` is
 * refreshed in place (same row, same id) rather than duplicated; one a user
 * added by hand (`source: 'manual'`) is left completely untouched, so
 * re-running discovery can never clobber a manual edit.
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
    const discovered = await container.engine.listModels(conn, apiKey);
    const saved = upsertDiscoveredModels(container, id, discovered);
    return c.json(saved);
  });

  return app;
}
