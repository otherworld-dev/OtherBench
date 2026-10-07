import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VIEWER, MAX_VIEWER_HISTORY, VIEWER_STORAGE_KEY, useViewerStore, viewerFor } from './state.js';

const file = (path: string) => ({ kind: 'file' as const, path });
const v = (chatId = 'c1') => viewerFor(useViewerStore.getState().viewers, chatId);

beforeEach(() => {
  window.localStorage.clear();
  useViewerStore.setState({ viewers: {} });
});

describe('viewer state', () => {
  it('keeps artifact items in history, telling versions apart', () => {
    const s = useViewerStore.getState();
    s.openItem('c1', { kind: 'artifact', artifactId: 'art', title: 'Calc' });
    s.openItem('c1', { kind: 'artifact', artifactId: 'art', title: 'Calc' });
    s.openItem('c1', { kind: 'artifact', artifactId: 'art', title: 'Calc', versionId: 'v1' });
    expect(v().history).toHaveLength(2);
    const saved = JSON.parse(window.localStorage.getItem(VIEWER_STORAGE_KEY)!) as Record<string, { history: unknown[] }>;
    expect(saved['c1']!.history).toHaveLength(2);
  });

  it('opens an item in the panel, with back and forward, dropping forward history on a new item', () => {
    const s = useViewerStore.getState();
    expect(v()).toEqual(DEFAULT_VIEWER);
    s.openItem('c1', file('a.md'));
    s.openItem('c1', file('b.md'));
    s.openItem('c1', file('b.md'));
    expect(v()).toMatchObject({ open: true, mode: 'item', history: [file('a.md'), file('b.md')], index: 1 });
    s.step('c1', -1);
    expect(v().index).toBe(0);
    s.step('c1', -1);
    expect(v().index).toBe(0);
    s.openItem('c1', file('c.md'));
    expect(v().history).toEqual([file('a.md'), file('c.md')]);
    expect(v('c2')).toEqual(DEFAULT_VIEWER);
  });

  it('keeps at most MAX_VIEWER_HISTORY items, the panel share within 0.2-0.8, and remembers it on this device', () => {
    const s = useViewerStore.getState();
    for (let i = 0; i < MAX_VIEWER_HISTORY + 5; i++) s.openItem('c1', file(`${i}.md`));
    expect(v().history).toHaveLength(MAX_VIEWER_HISTORY);
    expect(v().index).toBe(MAX_VIEWER_HISTORY - 1);
    s.setShare('c1', 0.95);
    expect(v().share).toBe(0.8);
    s.setOpen('c1', false);
    s.setMode('c1', 'files');
    const saved = JSON.parse(window.localStorage.getItem(VIEWER_STORAGE_KEY)!) as Record<string, { open: boolean; mode: string }>;
    expect(saved['c1']).toMatchObject({ open: false, mode: 'files', share: 0.8 });
  });
});
