import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@otherbench/core/types/config.js';
import { matchesSearch, newModelIds, sortModels } from './model-table.js';

function model(over: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    connectionId: 'conn-1',
    modelId: over.id,
    displayName: over.id,
    source: 'discovered',
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

describe('matchesSearch', () => {
  const opus = model({ id: 'm', modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' });

  it('matches the display name or the model id, ignoring case', () => {
    expect(matchesSearch(opus, 'OPUS')).toBe(true);
    expect(matchesSearch(opus, 'opus-5-5')).toBe(true);
    expect(matchesSearch(opus, 'Opus 5.5')).toBe(true);
    expect(matchesSearch(opus, 'sonnet')).toBe(false);
  });

  it('needs every word, wherever each one is', () => {
    expect(matchesSearch(opus, '5.5 claude')).toBe(true);
    expect(matchesSearch(opus, 'claude haiku')).toBe(false);
  });

  it('a blank search matches everything', () => {
    expect(matchesSearch(opus, '   ')).toBe(true);
  });
});

describe('newModelIds', () => {
  it('tags the models the latest run on a connection added', () => {
    const ids = newModelIds([
      model({ id: 'old', firstSeenAt: 100 }),
      model({ id: 'older', firstSeenAt: null }),
      model({ id: 'fresh', firstSeenAt: 200 }),
      model({ id: 'fresh2', firstSeenAt: 200 }),
    ]);
    expect([...ids].sort()).toEqual(['fresh', 'fresh2']);
  });

  it('tags nothing when a connection has had only one run, since every model came from it', () => {
    expect(newModelIds([model({ id: 'a', firstSeenAt: 100 }), model({ id: 'b', firstSeenAt: 100 })]).size).toBe(0);
  });

  it('works out each connection on its own', () => {
    const ids = newModelIds([
      model({ id: 'a1', connectionId: 'a', firstSeenAt: 100 }),
      model({ id: 'a2', connectionId: 'a', firstSeenAt: 300 }),
      model({ id: 'b1', connectionId: 'b', firstSeenAt: 200 }),
      model({ id: 'b2', connectionId: 'b', firstSeenAt: null }),
    ]);
    expect([...ids].sort()).toEqual(['a2', 'b1']);
  });

  it('tags nothing on a connection whose models have no first-seen time', () => {
    expect(newModelIds([model({ id: 'a' }), model({ id: 'b', firstSeenAt: null })]).size).toBe(0);
  });
});

describe('sortModels', () => {
  const names = new Map([
    ['conn-a', 'Anthropic'],
    ['conn-o', 'Ollama'],
  ]);
  const connectionName = (id: string): string => names.get(id) ?? '';
  const ids = (models: ModelInfo[]): string[] => models.map((m) => m.id);

  const models = [
    model({ id: 'llama', connectionId: 'conn-o', displayName: 'llama3.2', supportsTools: true, priceInPer1m: 0 }),
    model({ id: 'sonnet', connectionId: 'conn-a', displayName: 'Claude Sonnet 5.5', supportsVision: true, priceInPer1m: 3 }),
    model({ id: 'haiku', connectionId: 'conn-a', displayName: 'claude haiku 5.5', priceInPer1m: null }),
  ];

  it('by connection, then name ignoring case, by default', () => {
    expect(ids(sortModels(models, { key: 'connection', dir: 'asc' }, connectionName))).toEqual(['haiku', 'sonnet', 'llama']);
  });

  it('by name, either way round', () => {
    expect(ids(sortModels(models, { key: 'name', dir: 'asc' }, connectionName))).toEqual(['haiku', 'sonnet', 'llama']);
    expect(ids(sortModels(models, { key: 'name', dir: 'desc' }, connectionName))).toEqual(['llama', 'sonnet', 'haiku']);
  });

  it('by a capability puts the models that have it first, then by name', () => {
    expect(ids(sortModels(models, { key: 'vision', dir: 'asc' }, connectionName))).toEqual(['sonnet', 'haiku', 'llama']);
    expect(ids(sortModels(models, { key: 'tools', dir: 'asc' }, connectionName))).toEqual(['llama', 'haiku', 'sonnet']);
  });

  it('by price puts an unknown price last whichever way round', () => {
    expect(ids(sortModels(models, { key: 'price', dir: 'asc' }, connectionName))).toEqual(['llama', 'sonnet', 'haiku']);
    expect(ids(sortModels(models, { key: 'price', dir: 'desc' }, connectionName))).toEqual(['sonnet', 'llama', 'haiku']);
  });

  it('leaves the list it was given alone', () => {
    const before = ids(models);
    sortModels(models, { key: 'name', dir: 'desc' }, connectionName);
    expect(ids(models)).toEqual(before);
  });
});
