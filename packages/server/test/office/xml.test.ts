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

describe('attribute helpers', () => {
  it('finds an attribute by local name, and a prefixed one apart from a plain one of the same name', () => {
    expect(attr({ 'w:val': '2' }, 'val')).toBe('2');
    expect(attr({ id: '5', 'r:id': 'rId2' }, 'id')).toBe('5');
    expect(prefixedAttr({ id: '5', 'r:id': 'rId2' }, 'id')).toBe('rId2');
    expect(attr({ 'xmlns:r': 'urn:x' }, 'r')).toBeUndefined();
  });
});
