import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@otherbench/core/types/config.js';
import { freshDb } from '../helpers.js';
import { SqliteConnectionRepo } from '../../src/repos/connections.js';
import { SqliteModelRepo } from '../../src/repos/models.js';

function makeModel(over: Partial<ModelInfo> & { id: string; connectionId: string }): ModelInfo {
  return {
    modelId: 'test-model',
    displayName: 'Test Model',
    source: 'manual',
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    contextWindow: null,
    maxOutput: null,
    priceInPer1m: null,
    priceOutPer1m: null,
    priceCachedPer1m: null,
    currency: 'USD',
    ...over,
  };
}

describe('SqliteModelRepo', () => {
  it('create/get round-trips every field, including booleans and nullable numerics', () => {
    const db = freshDb();
    new SqliteConnectionRepo(db).create({
      id: 'conn-a',
      name: 'C',
      kind: 'mock',
      baseUrl: null,
      secretRef: null,
      extraHeaders: {},
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
    });
    const repo = new SqliteModelRepo(db);

    repo.create(
      makeModel({
        id: 'model-a',
        connectionId: 'conn-a',
        displayName: 'GPT Test',
        supportsVision: true,
        supportsTools: true,
        supportsReasoning: false,
        contextWindow: 128000,
        maxOutput: 4096,
        priceInPer1m: 3,
        priceOutPer1m: 15,
        priceCachedPer1m: 0.3,
      })
    );

    expect(repo.get('model-a')).toEqual({
      id: 'model-a',
      connectionId: 'conn-a',
      modelId: 'test-model',
      displayName: 'GPT Test',
      source: 'manual',
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: false,
      contextWindow: 128000,
      maxOutput: 4096,
      priceInPer1m: 3,
      priceOutPer1m: 15,
      priceCachedPer1m: 0.3,
      currency: 'USD',
    });
    db.close();
  });

  it('list(connectionId) filters to that connection; list() with no arg returns all', () => {
    const db = freshDb();
    const connections = new SqliteConnectionRepo(db);
    connections.create({
      id: 'conn-a',
      name: 'A',
      kind: 'mock',
      baseUrl: null,
      secretRef: null,
      extraHeaders: {},
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
    });
    connections.create({
      id: 'conn-b',
      name: 'B',
      kind: 'mock',
      baseUrl: null,
      secretRef: null,
      extraHeaders: {},
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
    });
    const repo = new SqliteModelRepo(db);
    repo.create(makeModel({ id: 'model-a', connectionId: 'conn-a' }));
    repo.create(makeModel({ id: 'model-b', connectionId: 'conn-b' }));

    expect(repo.list('conn-a').map((m) => m.id)).toEqual(['model-a']);
    expect(repo.list().map((m) => m.id).sort()).toEqual(['model-a', 'model-b']);
    db.close();
  });

  it('update throws when the id does not exist', () => {
    const db = freshDb();
    const repo = new SqliteModelRepo(db);
    expect(() => repo.update('does-not-exist', { displayName: 'x' })).toThrow(Error);
    db.close();
  });
});
