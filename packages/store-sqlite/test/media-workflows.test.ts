import { describe, expect, it } from 'vitest';
import type { MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

function node(id: string) {
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare('UPDATE node_self SET id = ?').run(id);
  return { db, store: new SqliteStore(db) };
}

const wf = (over: Partial<MediaWorkflow> = {}): MediaWorkflow => ({
  id: 'w1',
  name: 'Mine',
  media: 'image',
  graph: { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'x', clip: ['2', 0] } } },
  bindings: { prompt: { nodeId: '1', input: 'text' } },
  checkpoint: 'a.safetensors',
  builtin: false,
  ...over,
});

const push = (from: ReturnType<typeof node>, to: ReturnType<typeof node>) => to.store.sync.apply(from.store.sync.changesSince(0, 1000).rows);

describe('media workflows', () => {
  it('round-trips and stores rows as not built-in', () => {
    const { store } = node('a');
    store.mediaWorkflows.create(wf({ builtin: true }));
    expect(store.mediaWorkflows.get('w1')).toEqual(wf());
    expect(store.mediaWorkflows.list()).toEqual([wf()]);
    const patched = store.mediaWorkflows.update('w1', { name: 'Renamed', checkpoint: undefined });
    expect(patched.name).toBe('Renamed');
    expect(store.mediaWorkflows.get('w1')!.checkpoint).toBeUndefined();
    store.mediaWorkflows.delete('w1');
    expect(store.mediaWorkflows.get('w1')).toBeNull();
  });

  it('writes a sync change row on create', () => {
    const { db, store } = node('a');
    store.mediaWorkflows.create(wf());
    const rows = db.prepare("SELECT op FROM change_log WHERE tbl = 'media_workflow' AND row_id = 'w1'").all();
    expect(rows).toHaveLength(1);
  });

  it('syncs to another machine', () => {
    const a = node('a');
    const b = node('b');
    a.store.mediaWorkflows.create(wf());
    push(a, b);
    expect(b.store.mediaWorkflows.get('w1')).toEqual(wf());
  });

  describe('a row from another machine is held to the import rules', () => {
    const refused = (over: Partial<MediaWorkflow>, raw: Record<string, unknown> = {}) => {
      const a = node('a');
      const b = node('b');
      a.store.mediaWorkflows.create(wf());
      const w = { ...wf(), ...over };
      a.db
        .prepare('UPDATE media_workflow SET id = ?, name = ?, media = ?, graph = ?, bindings = ? WHERE id = ?')
        .run(w.id, w.name, w.media, (raw['graph'] as string) ?? JSON.stringify(w.graph), (raw['bindings'] as string) ?? JSON.stringify(w.bindings), 'w1');
      push(a, b);
      expect(b.store.mediaWorkflows.list()).toEqual([]);
    };

    it('refuses a binding to a missing input', () => refused({ bindings: { prompt: { nodeId: '1', input: 'nope' } } }));
    it('refuses no prompt binding', () => refused({ bindings: {} }));
    it('refuses a binding to a linked input', () => refused({ bindings: { prompt: { nodeId: '1', input: 'clip' } } }));
    it('refuses a built-in id', () => refused({ id: 'builtin:sdxl-txt2img' }));
    it('refuses malformed JSON', () => refused({}, { graph: '{not json' }));
    it('refuses the UI format', () => refused({}, { graph: JSON.stringify({ nodes: [], links: [] }) }));
    it('refuses a graph over 1 MB', () =>
      refused({ graph: { ...wf().graph, '9': { class_type: 'X', inputs: { pad: 'x'.repeat(1024 * 1024) } } } }));
  });
});
