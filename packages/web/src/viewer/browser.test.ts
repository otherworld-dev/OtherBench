import { describe, expect, it } from 'vitest';
import { browserCallLabel, browserPageOf, displayLines, oneLine, revealHidden } from './browser.js';

describe('browser display helpers', () => {
  it('labels each command the way the thread shows it', () => {
    expect(browserCallLabel({ command: 'open', url: 'https://example.com/' })).toBe('open https://example.com/');
    expect(browserCallLabel({ command: 'click', ref: 'e12' })).toBe('click e12');
    expect(browserCallLabel({ command: 'click', ref: 'e12', double: true })).toBe('double-click e12');
    expect(browserCallLabel({ command: 'type', ref: 'e3', text: 'secret' })).toBe('type into e3');
    expect(browserCallLabel({ command: 'select', ref: 'e4', values: ['a'] })).toBe('select in e4');
    expect(browserCallLabel({ command: 'press', key: 'Enter' })).toBe('press Enter');
    expect(browserCallLabel({ command: 'scroll' })).toBe('scroll down');
    expect(browserCallLabel({ command: 'scroll', direction: 'up', ref: 'e9' })).toBe('scroll up to e9');
    expect(browserCallLabel({ command: 'snapshot' })).toBe('snapshot');
    expect(browserCallLabel(null)).toBe('?');
  });

  it('shows page-derived text in a label as one plain line', () => {
    expect(browserCallLabel({ command: 'open', url: 'https://a.test/\u202eevil\nline two\u200b' })).toBe('open https://a.test/evil line two');
    expect(browserCallLabel({ command: 'click', ref: 'e1\u202e' })).toBe('click e1');
  });

  it('reads a page result from an object or its JSON text, and nothing else', () => {
    const page = { about: 'x', url: 'https://example.com/', title: 'Example', snapshot: '- heading "Hi"' };
    expect(browserPageOf(page)).toEqual({ url: 'https://example.com/', title: 'Example', snapshot: '- heading "Hi"' });
    expect(browserPageOf(JSON.stringify(page))).toEqual({ url: 'https://example.com/', title: 'Example', snapshot: '- heading "Hi"' });
    expect(browserPageOf({ error: true, message: 'no' })).toBeNull();
    expect(browserPageOf('not json')).toBeNull();
  });

  it('oneLine strips hidden and bidi characters and folds whitespace', () => {
    expect(oneLine('a\u202eb\u200bc\n\td  e')).toBe('abc d e');
    expect(oneLine(42)).toBe('');
  });

  it('revealHidden spells out hidden characters but keeps line breaks and tabs', () => {
    expect(revealHidden('a\u202eb\u200bc\nd\te')).toBe('a<U+202E>b<U+200B>c\nd\te');
  });

  it('displayLines sanitises each line but keeps the line structure and indentation', () => {
    expect(displayLines('- heading "a\u202eb" [ref=e1]\n  - link "c\u200bd"\u0007')).toBe('- heading "ab" [ref=e1]\n  - link "cd"');
  });
});
