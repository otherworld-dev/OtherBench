/**
 * Just enough XML for reading Office files (spec 2026-10-12-office-files §1):
 * one regex pass over tags and text, tags matched by local name (`w:p` and
 * `p` are the same), attributes from both quote styles, the five XML
 * entities and character references decoded, CDATA as text, comments and
 * processing instructions skipped. A DOCTYPE is refused outright, so no
 * entity is ever expanded. No validation: Office parts are machine-written.
 */

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

export interface XmlHandlers {
  /** A start tag; a self-closing one is followed straight away by `close`. Return false to stop. */
  open?(local: string, attrs: Record<string, string>, selfClosing: boolean): boolean | void;
  close?(local: string): boolean | void;
  /** Decoded text between tags, and CDATA. */
  text?(text: string): boolean | void;
}

// Groups: 1 CDATA, 2 end tag, 3 start tag name, 4 its attributes, 5 "/" when self-closing, 6 text.
// The last alternative swallows a stray "<" that isn't a tag.
const TOKEN = String.raw`<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|<`;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|amp|quot|apos));/g;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (all, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name) return NAMED[name] ?? all;
    const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export function scanXml(xml: string, handlers: XmlHandlers): void {
  if (/<!DOCTYPE/i.test(xml)) throw new XmlError('This part has a DOCTYPE, which Grunt refuses to read.');
  const token = new RegExp(TOKEN, 'g');
  for (let m = token.exec(xml); m !== null; m = token.exec(xml)) {
    let result: boolean | void = undefined;
    if (m[1] !== undefined) {
      result = handlers.text?.(m[1]);
    } else if (m[2] !== undefined) {
      result = handlers.close?.(localName(m[2]));
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? '').matchAll(ATTR)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '');
      const local = localName(m[3]);
      const selfClosing = m[5] === '/';
      result = handlers.open?.(local, attrs, selfClosing);
      if (result !== false && selfClosing) result = handlers.close?.(local);
    } else if (m[6] !== undefined) {
      result = handlers.text?.(decodeEntities(m[6]));
    }
    if (result === false) return;
  }
}

/** An attribute by local name: an unprefixed one first, then any prefix. Namespace declarations never count. */
export function attr(attrs: Readonly<Record<string, string>>, local: string): string | undefined {
  if (Object.hasOwn(attrs, local)) return attrs[local];
  for (const [key, value] of Object.entries(attrs)) if (!key.startsWith('xmlns') && key.endsWith(`:${local}`)) return value;
  return undefined;
}

/** A prefixed attribute only, e.g. `r:id` next to a plain `id`. */
export function prefixedAttr(attrs: Readonly<Record<string, string>>, local: string): string | undefined {
  for (const [key, value] of Object.entries(attrs)) if (!key.startsWith('xmlns') && key.endsWith(`:${local}`)) return value;
  return undefined;
}
