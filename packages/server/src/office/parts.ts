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

/** At most this many distinct notes are kept, and each is cut to this length, so a file full of oversize parts can't flood the output. */
const MAX_NOTES = 10;
const MAX_NOTE_CHARS = 300;

export class OfficeParts {
  private readonly entries = new Map<string, ZipEntry>();
  private total = 0;
  /** Each part's text (null: over the part cap), by lower-cased name, so a part is inflated once however often and in whatever case of its name it is asked for. What is held is at most the bytes charged to the total. */
  private readonly read = new Map<string, string | null>();
  private readonly noted = new Set<string>();
  private readonly kept: string[] = [];
  private extraNotes = 0;
  /** True once the total cap was reached: nothing more is read. */
  stopped = false;

  constructor(
    private readonly zip: Buffer,
    private readonly limits: OfficeLimits
  ) {
    for (const entry of listZipEntries(zip)) this.entries.set(entry.name.toLowerCase(), entry);
  }

  /** What was skipped, for the end of the text: each note once, the first few in full and a count of the rest. */
  get notes(): string[] {
    return this.extraNotes > 0 ? [...this.kept, `[OtherBench skipped ${this.extraNotes} more part${this.extraNotes === 1 ? '' : 's'} as well.]`] : [...this.kept];
  }

  private note(text: string): void {
    const note = text.length > MAX_NOTE_CHARS ? `${text.slice(0, MAX_NOTE_CHARS)}...]` : text;
    if (this.noted.has(note)) return;
    this.noted.add(note);
    if (this.kept.length < MAX_NOTES) this.kept.push(note);
    else this.extraNotes++;
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase());
  }

  /** The part as UTF-8 text, or null when it's missing, over a cap (with a note), or reading has stopped. Every call is charged its size against the total cap, but a part is inflated once. */
  text(name: string): string | null {
    const key = name.toLowerCase();
    const entry = this.entries.get(key);
    if (!entry || this.stopped) return null;
    const cached = this.read.get(key);
    // An over-cap part was never read, so asking again costs nothing.
    if (cached === null) return null;
    if (entry.size > this.limits.maxPartBytes) {
      this.note(`[OtherBench skipped ${entry.name}: it's over the ${mb(this.limits.maxPartBytes)} OtherBench reads from one part.]`);
      this.read.set(key, null);
      return null;
    }
    if (this.total + entry.size > this.limits.maxTotalBytes) {
      this.stopped = true;
      this.note(`[OtherBench stopped reading here: this file's parts come to over ${mb(this.limits.maxTotalBytes)}.]`);
      return null;
    }
    // Every call is charged, a cached part too, so what a reader scans over and over is still bounded by the total cap; only the inflating is saved.
    this.total += entry.size;
    if (cached !== undefined) return cached;
    const text = readZipEntry(this.zip, entry, this.limits.maxPartBytes).toString('utf8');
    this.read.set(key, text);
    return text;
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

  private stopped = false;

  /** Past the cap (not at it), so the text is always longer than the cap once full and attachment-text.ts's truncate() marks it; or stopped by the reader, which dropped text it couldn't hold. */
  get full(): boolean {
    return this.stopped || this.chars > this.maxChars;
  }

  /** How many more characters fit before the cap (negative once past it). */
  get room(): number {
    return this.maxChars - this.chars;
  }

  get last(): string | undefined {
    return this.lines.at(-1);
  }

  /** The reader dropped text it couldn't hold within the cap: the text is full whatever its length. */
  stop(): void {
    this.stopped = true;
  }

  /** Adds a line; false once the text is full (stop reading). A line that doesn't fit is cut so the text ends one character past the cap (at most maxChars + 1 long), not at the end of whatever the reader buffered. */
  line(text: string): boolean {
    if (this.full) return false;
    const fit = this.maxChars - this.chars + 1;
    const kept = text.length > fit ? text.slice(0, fit) : text;
    this.lines.push(kept);
    this.chars += kept.length + 1;
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
