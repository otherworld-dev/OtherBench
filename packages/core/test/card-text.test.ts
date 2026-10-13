import { describe, expect, it } from 'vitest';
import { cardLine, hasHiddenCharacter, HIDDEN_RANGES, isHiddenCodePoint, isWellFormedText, revealAllHidden, revealHidden } from '../src/domain/card-text.js';

describe('card text', () => {
  it('keeps one frozen table of hidden characters', () => {
    expect(Object.isFrozen(HIDDEN_RANGES)).toBe(true);
    expect(HIDDEN_RANGES.every((range) => Object.isFrozen(range))).toBe(true);
    expect(() => (HIDDEN_RANGES as unknown as number[][]).push([0x41, 0x5a])).toThrow();
    for (const cp of [0x0000, 0x001b, 0x007f, 0x00ad, 0x200b, 0x202e, 0x2066, 0xfe0f, 0xfeff, 0xe0041]) expect(isHiddenCodePoint(cp), cp.toString(16)).toBe(true);
    for (const cp of [0x0020, 0x0041, 0x00e9, 0x212a, 0x1f600]) expect(isHiddenCodePoint(cp), cp.toString(16)).toBe(false);
  });

  it('makes untrusted text one plain line', () => {
    expect(cardLine('Approved\nby policy\u202e', 80)).toBe('Approved by policy');
    expect(cardLine('a\u202eb\u200bc\r\n\td  e\u0000\u001b[31m', 80)).toBe('abc d e[31m');
    expect(cardLine('  two\u2028lines\u2029here\u0085now  ', 80)).toBe('two lines here now');
    expect(cardLine('tag\u{e0041}\u{e007f} and selector\ufe0f', 80)).toBe('tag and selector');
  });

  it('cuts a long line by code point and marks the cut', () => {
    expect(cardLine('x'.repeat(500), 80)).toBe(`${'x'.repeat(80)}\u2026`);
    expect(cardLine('x'.repeat(80), 80)).toBe('x'.repeat(80));
    // An emoji (two UTF-16 units) straddling the cut is kept whole or dropped whole.
    const cut = cardLine(`${'a'.repeat(39)}\u{1f600}\u{1f600}`, 40);
    expect(cut).toBe(`${'a'.repeat(39)}\u{1f600}\u2026`);
    expect(isWellFormedText(cut)).toBe(true);
    expect(cardLine('abc def', 4)).toBe('abc\u2026');
    expect(cardLine('abc', 0)).toBe('\u2026');
    expect(cardLine('abc', Number.NaN)).toBe('\u2026');
    expect(cardLine('abc', Number.POSITIVE_INFINITY)).toBe('abc');
  });

  it('gives the empty line for anything that is not text, and drops a lone surrogate', () => {
    for (const bad of [undefined, null, 42, {}, ['a']]) expect(cardLine(bad, 80)).toBe('');
    expect(cardLine('a\ud800b', 80)).toBe('ab');
  });

  it('spells out hidden characters, keeping line breaks and tabs where text may have them', () => {
    expect(revealHidden('a\u202eb\u200bc\nd\te')).toBe('a<U+202E>b<U+200B>c\nd\te');
    expect(revealHidden('x\u0000y\rz\ud800')).toBe('x<U+0000>y<U+000D>z<U+D800>');
    expect(revealAllHidden('C:\\a\\b\u202e.exe')).toBe('C:\\a\\b<U+202E>.exe');
    expect(revealAllHidden('a\nb\tc\ufffd')).toBe('a<U+000A>b<U+0009>c<U+FFFD>');
    expect(revealAllHidden('plain caf\u00e9')).toBe('plain caf\u00e9');
  });

  it('knows text that cannot be written down, and text with something hidden in it', () => {
    expect(isWellFormedText('ok \u{1f600}')).toBe(true);
    expect(isWellFormedText('bad \ud83d')).toBe(false);
    expect(isWellFormedText('bad \ude00 tail')).toBe(false);
    expect(isWellFormedText(42)).toBe(false);
    expect(hasHiddenCharacter('plain caf\u00e9 \u{1f600}')).toBe(false);
    for (const hidden of ['a\u200bb', 'a\u202eb', 'a\u0000b', 'a\ufffdb', 'a\ud800b', 'a\nb']) expect(hasHiddenCharacter(hidden)).toBe(true);
  });
});
