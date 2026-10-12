import { listZipEntries, readZipEntry, type ZipEntry } from '../import/zip.js';
import { scanXml } from './xml.js';

/**
 * Reading an Office file's parts with the spec's caps (2026-10-12-office-files,
 * Decisions "Reading"): a part over `maxPartBytes` uncompressed is skipped
 * with a note, and reading stops once the parts read come to `maxTotalBytes`.
 * `readZipEntry` never inflates past an entry's stated size, so a ZIP bomb
 * can't get past these. Part names are compared ignoring case, as OPC says.
 */
export interface OfficeLimits {
  maxPartBytes: number;
  maxTotalBytes: number;
  /** Stop once the text reaches this many characters (MAX_EXTRACTED_TEXT_CHARS, passed in by attachment-text.ts). */
  maxChars: number;
}

export const OFFICE_LIMITS: OfficeLimits = { maxPartBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxChars: 100_000 };

const mb = (bytes: number): string => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

export class OfficeParts {
  private readonly entries = new Map<string, ZipEntry>();
  private total = 0;
  /** True once the total cap was reached: nothing more is read. */
  stopped = false;
  /** What was skipped, for the end of the text. */
  readonly notes: string[] = [];

  constructor(
    private readonly zip: Buffer,
    private readonly limits: OfficeLimits
  ) {
    for (const entry of listZipEntries(zip)) this.entries.set(entry.name.toLowerCase(), entry);
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  /** The part as UTF-8 text, or null when it's missing, over a cap (with a note), or reading has stopped. */
  text(name: string): string | null {
    const entry = this.entries.get(name.toLowerCase());
    if (!entry || this.stopped) return null;
    if (entry.size > this.limits.maxPartBytes) {
      this.notes.push(`[Grunt skipped ${entry.name}: it's over the ${mb(this.limits.maxPartBytes)} Grunt reads from one part.]`);
      return null;
    }
    if (this.total + entry.size > this.limits.maxTotalBytes) {
      this.stopped = true;
      this.notes.push(`[Grunt stopped reading here: this file's parts come to over ${mb(this.limits.maxTotalBytes)}.]`);
      return null;
    }
    this.total += entry.size;
    return readZipEntry(this.zip, entry, this.limits.maxPartBytes).toString('utf8');
  }

  /** A part's relationships by id: target part name and type. External targets (links) are left out. */
  rels(partName: string): Map<string, { target: string; type: string }> {
    const slash = partName.lastIndexOf('/');
    const dir = partName.slice(0, slash + 1);
    const out = new Map<string, { target: string; type: string }>();
    const xml = this.text(`${dir}_rels/${partName.slice(slash + 1)}.rels`);
    if (xml === null) return out;
    scanXml(xml, {
      open(local, attrs) {
        if (local !== 'Relationship' || attrs['TargetMode'] === 'External') return;
        const id = attrs['Id'];
        const target = attrs['Target'];
        if (id && target) out.set(id, { target: resolvePart(dir, target), type: attrs['Type'] ?? '' });
      },
    });
    return out;
  }
}

/** A relationship target as a part name: absolute ("/xl/x.xml") or relative to `dir` ("ppt/slides/"), with "." and ".." resolved. */
export function resolvePart(dir: string, target: string): string {
  const segments = (target.startsWith('/') ? target.slice(1) : dir + target).split('/');
  const out: string[] = [];
  for (const s of segments) {
    if (s === '..') out.pop();
    else if (s !== '.' && s !== '') out.push(s);
  }
  return out.join('/');
}

/** The text being built, line by line, that reports full once it reaches its cap so the reader can stop. */
export class TextOut {
  private readonly lines: string[] = [];
  private chars = 0;

  constructor(private readonly maxChars: number) {}

  /** Past the cap (not at it), so the text is always longer than the cap once full and attachment-text.ts's truncate() marks it. */
  get full(): boolean {
    return this.chars > this.maxChars;
  }

  get last(): string | undefined {
    return this.lines.at(-1);
  }

  /** Adds a line; false once the text is full (stop reading). */
  line(text: string): boolean {
    if (this.full) return false;
    this.lines.push(text);
    this.chars += text.length + 1;
    return !this.full;
  }

  toString(): string {
    return this.lines.join('\n').trimEnd();
  }
}

/** Rows as a Markdown table: the first row is the header, short rows are padded, pipes escaped. */
export function markdownTable(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const width = rows.reduce((w, r) => Math.max(w, r.length), 1);
  const cell = (text: string): string => text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  const line = (row: string[]): string => `| ${Array.from({ length: width }, (_, i) => cell(row[i] ?? '')).join(' | ')} |`;
  return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)];
}
