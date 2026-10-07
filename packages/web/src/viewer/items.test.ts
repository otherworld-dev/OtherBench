import { describe, expect, it } from 'vitest';
import { isViewTab, itemName, parseViewTab, viewTabId } from './items.js';

describe('viewer items', () => {
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
