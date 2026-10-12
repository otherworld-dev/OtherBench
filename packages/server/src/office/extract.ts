import { OFFICE_LIMITS, OfficeParts, TextOut, type OfficeLimits } from './parts.js';
import { readWord } from './word.js';

/**
 * An Office file's text (spec 2026-10-12-office-files §1), read with Grunt's
 * own ZIP reader: no new dependencies, and no inflating past an entry's
 * stated size. The main part that's present decides the kind, so a misnamed
 * file is still read as what it is. Null when there's no Office main part or
 * nothing came out; throws ZipError/XmlError for a file it can't read (the
 * caller turns that into null).
 */
export function extractOfficeText(data: Buffer, limits: Partial<OfficeLimits> = {}): string | null {
  const caps: OfficeLimits = { ...OFFICE_LIMITS, ...limits };
  const parts = new OfficeParts(data, caps);
  const out = new TextOut(caps.maxChars);
  if (parts.has('word/document.xml')) readWord(parts, out);
  else return null;
  const text = [out.toString(), ...parts.notes].filter((t) => t !== '').join('\n\n');
  return text.trim() === '' ? null : text;
}
