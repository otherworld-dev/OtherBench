import { describe, expect, it } from 'vitest';
import { ESCAPE_STOPS_REPLY_ATTR, escapeStopsReply } from './escapeStopsReply.js';

function key(target: EventTarget, over: Partial<{ key: string; defaultPrevented: boolean; isComposing: boolean }> = {}) {
  return { key: 'Escape', defaultPrevented: false, isComposing: false, target, ...over };
}

describe('escapeStopsReply', () => {
  it('is true for Escape on something that is not a text box', () => {
    const div = document.createElement('div');
    expect(escapeStopsReply(key(div))).toBe(true);
  });

  it('is true for Escape in the message box, which carries the marker', () => {
    const box = document.createElement('textarea');
    box.setAttribute(ESCAPE_STOPS_REPLY_ATTR, '');
    expect(escapeStopsReply(key(box))).toBe(true);
  });

  it('is false in any other text box, select or editable element', () => {
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', '');
    for (const el of [document.createElement('textarea'), document.createElement('input'), document.createElement('select'), editable]) {
      expect(escapeStopsReply(key(el))).toBe(false);
    }
  });

  it('is false for another key, an Escape something else used, or one that ends an IME composition', () => {
    const div = document.createElement('div');
    expect(escapeStopsReply(key(div, { key: 'Enter' }))).toBe(false);
    expect(escapeStopsReply(key(div, { defaultPrevented: true }))).toBe(false);
    expect(escapeStopsReply(key(div, { isComposing: true }))).toBe(false);
  });
});
