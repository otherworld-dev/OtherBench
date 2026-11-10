import type { ModelInfo } from '@otherbench/core/types/config.js';

export type SortKey = 'name' | 'connection' | 'vision' | 'tools' | 'price';
export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** Whether every word of `query` is in the model's display name or model id, ignoring case. A blank query matches. */
export function matchesSearch(model: ModelInfo, query: string): boolean {
  const haystack = `${model.displayName} ${model.modelId}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * The models the latest "Discover models" run on their connection added:
 * those stamped with the connection's newest `firstSeenAt`. A connection whose
 * models all share that stamp has had one run, which found everything, so
 * nothing there is new. A model with no stamp (added by hand, or found before
 * stamps were kept) counts as older than any run.
 */
export function newModelIds(models: ModelInfo[]): Set<string> {
  const byConnection = new Map<string, ModelInfo[]>();
  for (const m of models) byConnection.set(m.connectionId, [...(byConnection.get(m.connectionId) ?? []), m]);
  const ids = new Set<string>();
  for (const group of byConnection.values()) {
    const stamps = group.map((m) => m.firstSeenAt ?? null);
    const latest = Math.max(...stamps.map((s) => s ?? -Infinity));
    if (!Number.isFinite(latest) || stamps.every((s) => s === latest)) continue;
    for (const m of group) if (m.firstSeenAt === latest) ids.add(m.id);
  }
  return ids;
}

const byName = (a: ModelInfo, b: ModelInfo): number => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });

/**
 * A sorted copy. Ties fall back to the name. Vision and Tools put the models
 * that have it first when ascending; price sorts on the input price and keeps
 * an unknown one last either way round.
 */
export function sortModels(models: ModelInfo[], sort: Sort, connectionName: (id: string) => string): ModelInfo[] {
  const flip = sort.dir === 'asc' ? 1 : -1;
  const compare = (a: ModelInfo, b: ModelInfo): number => {
    switch (sort.key) {
      case 'name':
        return flip * byName(a, b);
      case 'connection':
        return flip * connectionName(a.connectionId).localeCompare(connectionName(b.connectionId), undefined, { sensitivity: 'base' }) || byName(a, b);
      case 'vision':
        return flip * (Number(b.supportsVision) - Number(a.supportsVision)) || byName(a, b);
      case 'tools':
        return flip * (Number(b.supportsTools) - Number(a.supportsTools)) || byName(a, b);
      case 'price': {
        if (a.priceInPer1m === null || b.priceInPer1m === null) return (a.priceInPer1m === null ? 1 : 0) - (b.priceInPer1m === null ? 1 : 0) || byName(a, b);
        return flip * (a.priceInPer1m - b.priceInPer1m) || byName(a, b);
      }
    }
  };
  return [...models].sort(compare);
}
