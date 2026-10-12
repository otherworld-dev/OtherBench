import { describe, expect, it } from 'vitest';
import { attr, prefixedAttr, scanXml, XmlError } from '../../src/office/xml.js';

describe('scanXml', () => {
  it('matches tags by local name, reads both quote styles, and decodes entities and CDATA', () => {
    const events: string[] = [];
    scanXml(
      `<?xml version="1.0"?><w:document xmlns:w="x"><!-- note --><w:p a='1' w:val="a &amp; b"><w:t>x &lt; y &#65;&#x42;</w:t><![CDATA[<raw>]]><w:br/></w:p></w:document>`,
      {
        open: (local, attrs, selfClosing) => void events.push(`open ${local} ${JSON.stringify(attrs)}${selfClosing ? ' /' : ''}`),
        close: (local) => void events.push(`close ${local}`),
        text: (text) => void events.push(`text ${text}`),
      }
    );
    expect(events).toEqual([
      'open document {"xmlns:w":"x"}',
      'open p {"a":"1","w:val":"a & b"}',
      'open t {}',
      'text x < y AB',
      'close t',
      'text <raw>',
      'open br {} /',
      'close br',
      'close p',
      'close document',
    ]);
  });

  it('reads a ">" inside a quoted attribute value', () => {
    const seen: Record<string, string>[] = [];
    scanXml('<a title="1 > 0"/>', { open: (_l, attrs) => void seen.push(attrs) });
    expect(seen).toEqual([{ title: '1 > 0' }]);
  });

  it('stops as soon as a handler returns false', () => {
    const texts: string[] = [];
    scanXml('<a><t>one</t><t>two</t></a>', { text: (t) => { texts.push(t); return false; } });
    expect(texts).toEqual(['one']);
  });

  it('refuses a DOCTYPE', () => {
    expect(() => scanXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>', {})).toThrow(XmlError);
  });
});

describe('scanXml on hostile input', () => {
  // About 1-2 MB each. A linear scanner takes tens of milliseconds; a quadratic one takes minutes.
  const MB = 1024 * 1024;

  function run(name: string, xml: string): void {
    const started = performance.now();
    let events = 0;
    let outcome = 'completed';
    try {
      scanXml(xml, {
        open: () => void events++,
        close: () => void events++,
        text: () => void events++,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(XmlError);
      outcome = 'XmlError';
    }
    const ms = performance.now() - started;
    expect(ms, `${name}: ${ms.toFixed(0)} ms (${outcome}, ${events} events)`).toBeLessThan(2000);
  }

  const repeat = (unit: string, bytes = MB): string => unit.repeat(Math.ceil(bytes / unit.length));

  it.each([
    ['unterminated comments', '<!--'],
    ['unterminated CDATA', '<![CDATA['],
    ['unterminated declarations', '<!x'],
    ['unterminated processing instructions', '<?'],
    ['unterminated end tags', '</a'],
    ['unterminated start tags', '<a'],
    ['unterminated start tags with attributes', '<a b="1" '],
    ['unterminated attribute values', '<a b="'],
    ['stray angle brackets', '<'],
    ['nested open tags', '<a>'],
    ['open and close pairs', '<a></a>'],
    ['entity-heavy text', '&amp;&#65;&bogus;&#x;'],
  ])('stays linear on %s', (name, unit) => {
    run(name, repeat(unit));
  });

  it('stays linear on one start tag with a huge attribute list and no ">"', () => {
    run('many attributes, no >', `<a ${repeat('b="1" ', 2 * MB)}`);
  });

  it('stays linear on one start tag with a huge attribute list that closes', () => {
    run('many attributes, closed', `<a ${repeat('b="1" ', 2 * MB)}/>`);
  });

  it('stays linear on a long run of whitespace inside a tag', () => {
    run('whitespace in a tag', `<a${' '.repeat(2 * MB)}`);
  });

  it('stays linear on deep nesting', () => {
    run('deep nesting', repeat('<a>', 300_000) + repeat('</a>', 300_000));
  });

  it('refuses an unterminated comment, CDATA section or processing instruction', () => {
    expect(() => scanXml('<a><!-- never ends</a>', {})).toThrow(XmlError);
    expect(() => scanXml('<a><![CDATA[ never ends</a>', {})).toThrow(XmlError);
    expect(() => scanXml('<a><?php never ends</a>', {})).toThrow(XmlError);
  });

  it('still treats a stray "<" that is not a tag as nothing', () => {
    const texts: string[] = [];
    scanXml('<a>1 < 2</a>', { text: (t) => void texts.push(t) });
    expect(texts).toEqual(['1 ', ' 2']);
  });
});

describe('attribute helpers', () => {
  it('finds an attribute by local name, and a prefixed one apart from a plain one of the same name', () => {
    expect(attr({ 'w:val': '2' }, 'val')).toBe('2');
    expect(attr({ id: '5', 'r:id': 'rId2' }, 'id')).toBe('5');
    expect(prefixedAttr({ id: '5', 'r:id': 'rId2' }, 'id')).toBe('rId2');
    expect(attr({ 'xmlns:r': 'urn:x' }, 'r')).toBeUndefined();
  });
});
