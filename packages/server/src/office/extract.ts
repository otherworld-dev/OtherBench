import { readExcel } from './excel.js';
import { OFFICE_LIMITS, OfficeParts, TextOut, type OfficeLimits } from './parts.js';
import { readPowerPoint } from './powerpoint.js';
import { readWord } from './word.js';

/** The most characters of skip notes added after the text (ten notes of at most 300 and the "more" line fit). */
const MAX_NOTES_CHARS = 3200;

/**
 * An Office file's text (spec 2026-10-12-office-files §1), read with OtherBench's
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
  else if (parts.has('xl/workbook.xml')) readExcel(parts, out);
  else if (parts.has('ppt/presentation.xml')) readPowerPoint(parts, out);
  else return null;
  let body = out.toString();
  const stopNotes: string[] = [];
  // A reader that stopped with the text not yet past the cap says so itself (past the cap, attachment-text.ts's truncate() marks it).
  // The note stays inside the cap, by trimming the end of the text to make room, so truncate() never cuts it or marks the end twice.
  if (out.full && body.length <= caps.maxChars) {
    const note = `[OtherBench stopped reading here: the text reached its ${caps.maxChars}-character limit.]`;
    body = body.slice(0, Math.max(0, caps.maxChars - note.length - 2)).trimEnd();
    stopNotes.push(note);
  }
  // OfficeParts keeps few, short notes; the cap here is a last guard so the text is never more than a small bound past the limit.
  const partNotes = parts.notes.join('\n\n').slice(0, MAX_NOTES_CHARS);
  const text = [body, ...stopNotes, partNotes].filter((t) => t !== '').join('\n\n');
  return text.trim() === '' ? null : text;
}
