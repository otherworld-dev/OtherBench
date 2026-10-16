/**
 * Just enough XML for reading Office files (spec 2026-10-12-office-files §1):
 * one pass over tags and text, tags matched by local name (`w:p` and
 * `p` are the same), attributes from both quote styles, the five XML
 * entities and character references decoded, CDATA as text, comments and
 * processing instructions skipped. A DOCTYPE is refused outright, so no
 * entity is ever expanded. No validation: Office parts are machine-written.
 *
 * The scan is linear in the input however hostile it is: terminators are found
 * with `indexOf` and an unterminated comment, CDATA section, processing
 * instruction or declaration is an `XmlError` rather than something to rescan
 * from every later "<", and the tag regexes can't cross a "<".
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

// Start and end tags, matched at one position (sticky). Every character class
// excludes "<" (XML forbids a raw "<" in a name or an attribute value), so an
// attempt can never run past the next "<" and a failed one costs only the
// distance to it. That keeps the scan linear however hostile the input is.
// Groups: 1 name, 2 attributes, 3 "/" when self-closing.
const START_TAG = /<([^\s/><!?]+)((?:\s+[^\s=/><]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const END_TAG = /<\/([^\s><]+)\s*>/y;
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

/** The end of a comment, CDATA section, processing instruction or declaration that starts at `from`. An unterminated one is fatal rather than rescanned from every later "<". */
function endOf(xml: string, from: number, terminator: string, what: string): number {
  const at = xml.indexOf(terminator, from);
  if (at === -1) throw new XmlError(`This part has an unterminated ${what}.`);
  return at;
}

export function scanXml(xml: string, handlers: XmlHandlers): void {
  if (/<!DOCTYPE/i.test(xml)) throw new XmlError('This part has a DOCTYPE, which OtherBench refuses to read.');
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd > i && handlers.text?.(decodeEntities(xml.slice(i, textEnd))) === false) return;
    if (lt === -1) return;
    i = lt;

    let result: boolean | void = undefined;
    if (xml.startsWith('<!--', i)) {
      i = endOf(xml, i + 4, '-->', 'comment') + 3;
    } else if (xml.startsWith('<![CDATA[', i)) {
      const end = endOf(xml, i + 9, ']]>', 'CDATA section');
      result = handlers.text?.(xml.slice(i + 9, end));
      i = end + 3;
    } else if (xml.startsWith('<?', i)) {
      i = endOf(xml, i + 2, '?>', 'processing instruction') + 2;
    } else if (xml.startsWith('<!', i)) {
      i = endOf(xml, i + 2, '>', 'declaration') + 1;
    } else if (xml.startsWith('</', i)) {
      END_TAG.lastIndex = i;
      const m = END_TAG.exec(xml);
      if (m) {
        i += m[0].length;
        result = handlers.close?.(localName(m[1]!));
      } else {
        i++; // a stray "<"
      }
    } else {
      START_TAG.lastIndex = i;
      const m = START_TAG.exec(xml);
      if (m) {
        i += m[0].length;
        const attrs: Record<string, string> = {};
        for (const a of (m[2] ?? '').matchAll(ATTR)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '');
        const local = localName(m[1]!);
        const selfClosing = m[3] === '/';
        result = handlers.open?.(local, attrs, selfClosing);
        if (result !== false && selfClosing) result = handlers.close?.(local);
      } else {
        i++; // a stray "<"
      }
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
