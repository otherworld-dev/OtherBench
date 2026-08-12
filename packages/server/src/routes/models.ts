import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ModelInfo } from '@grunt/core/types/config.js';
import type { Container } from '../container.js';
import { optionalBoolean, optionalNumber, requireNonEmptyString } from '../validation.js';

interface ModelBody {
  connectionId?: unknown;
  modelId?: unknown;
  displayName?: unknown;
  supportsVision?: unknown;
  supportsTools?: unknown;
  supportsReasoning?: unknown;
  contextWindow?: unknown;
  maxOutput?: unknown;
  priceInPer1m?: unknown;
  priceOutPer1m?: unknown;
  priceCachedPer1m?: unknown;
  currency?: unknown;
}

function getModelOrThrow(container: Container, id: string): ModelInfo {
  const model = container.store.models.get(id);
  if (!model) throw new HTTPException(404, { message: `Model "${id}" not found.` });
  return model;
}

export function modelsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const connectionId = c.req.query('connectionId');
    return c.json(container.store.models.list(connectionId));
  });

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ModelBody;
    const created = container.store.models.create({
      id: randomUUID(),
      connectionId: requireNonEmptyString(body.connectionId, 'connectionId'),
      modelId: requireNonEmptyString(body.modelId, 'modelId'),
      displayName: requireNonEmptyString(body.displayName, 'displayName'),
      source: 'manual',
      supportsVision: optionalBoolean(body.supportsVision, 'supportsVision', false),
      supportsTools: optionalBoolean(body.supportsTools, 'supportsTools', false),
      supportsReasoning: optionalBoolean(body.supportsReasoning, 'supportsReasoning', false),
      contextWindow: optionalNumber(body.contextWindow, 'contextWindow') ?? null,
      maxOutput: optionalNumber(body.maxOutput, 'maxOutput') ?? null,
      priceInPer1m: optionalNumber(body.priceInPer1m, 'priceInPer1m') ?? null,
      priceOutPer1m: optionalNumber(body.priceOutPer1m, 'priceOutPer1m') ?? null,
      priceCachedPer1m: optionalNumber(body.priceCachedPer1m, 'priceCachedPer1m') ?? null,
      currency: typeof body.currency === 'string' ? body.currency : 'USD',
    });
    return c.json(created, 201);
  });

  app.get('/:id', (c) => c.json(getModelOrThrow(container, c.req.param('id'))));

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    getModelOrThrow(container, id);
    const body = (await c.req.json().catch(() => ({}))) as ModelBody;

    const patch: Partial<Omit<ModelInfo, 'id'>> = {};
    if (body.displayName !== undefined) patch.displayName = requireNonEmptyString(body.displayName, 'displayName');
    if (body.supportsVision !== undefined) patch.supportsVision = optionalBoolean(body.supportsVision, 'supportsVision', false);
    if (body.supportsTools !== undefined) patch.supportsTools = optionalBoolean(body.supportsTools, 'supportsTools', false);
    if (body.supportsReasoning !== undefined) patch.supportsReasoning = optionalBoolean(body.supportsReasoning, 'supportsReasoning', false);
    if (body.contextWindow !== undefined) patch.contextWindow = optionalNumber(body.contextWindow, 'contextWindow') ?? null;
    if (body.maxOutput !== undefined) patch.maxOutput = optionalNumber(body.maxOutput, 'maxOutput') ?? null;
    if (body.priceInPer1m !== undefined) patch.priceInPer1m = optionalNumber(body.priceInPer1m, 'priceInPer1m') ?? null;
    if (body.priceOutPer1m !== undefined) patch.priceOutPer1m = optionalNumber(body.priceOutPer1m, 'priceOutPer1m') ?? null;
    if (body.priceCachedPer1m !== undefined) patch.priceCachedPer1m = optionalNumber(body.priceCachedPer1m, 'priceCachedPer1m') ?? null;
    if (typeof body.currency === 'string') patch.currency = body.currency;

    return c.json(container.store.models.update(id, patch));
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    getModelOrThrow(container, id);
    container.store.models.delete(id);
    return c.body(null, 204);
  });

  return app;
}
