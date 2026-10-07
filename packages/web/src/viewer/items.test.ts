import { describe, expect, it } from 'vitest';
import { isViewTab, itemKey, itemName, parseViewTab, viewTabId } from './items.js';

describe('viewer items', () => {
  it('round-trips an artifact item, named by its title', () => {
    const item = { kind: 'artifact' as const, artifactId: 'art', title: 'Calc', versionId: 'v2' };
    expect(parseViewTab(viewTabId('c1', item))).toEqual({ chatId: 'c1', item });
    expect(parseViewTab(viewTabId('c1', { kind: 'artifact', artifactId: 'art', title: 'Calc' }))).toEqual({ chatId: 'c1', item: { kind: 'artifact', artifactId: 'art', title: 'Calc' } });
    expect(itemName(item)).toBe('Calc');
    expect(itemKey(item)).toBe('artifact:art:v2');
    expect(itemKey({ kind: 'file', path: 'a.md' })).toBe('file:a.md');
    // A malformed artifact tab is no tab.
    expect(parseViewTab(viewTabId('c1', { kind: 'artifact', artifactId: 'art', title: 7 } as never))).toBeNull();
  });

  it('round-trips a viewer tab id, and tells it from a chat id', () => {
    const id = viewTabId('chat-1', { kind: 'file', path: 'C:\\Work\\notes #1.md' });
    expect(isViewTab(id)).toBe(true);
    expect(isViewTab('0b9d2f1e-chat')).toBe(false);
    expect(isViewTab(null)).toBe(false);
    expect(parseViewTab(id)).toEqual({ chatId: 'chat-1', item: { kind: 'file', path: 'C:\\Work\\notes #1.md' } });
    for (const bad of ['view:', 'view:%7B', 'view:' + encodeURIComponent('{"chatId":1}'), 'chat-1']) expect(parseViewTab(bad)).toBeNull();
  });

  it("names an item by its file's name", () => {
    expect(itemName({ kind: 'file', path: 'C:\\Work\\a.md' })).toBe('a.md');
    expect(itemName({ kind: 'file', path: 'src/b.ts' })).toBe('b.ts');
  });
});
