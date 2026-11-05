/**
 * App notes (spec 2026-11-05-app-notes-design): an app's standing facts, as
 * short markdown lines under `## ` headings. Pure: placing a fact, moving or
 * editing one, the prompt blocks, the offer tag a model writes, and the copy
 * mirrored to Collectives.
 */
import type { AppNotes } from '../ports/store.js';

/** The headings a new app's notes start with. */
export const APP_NOTES_HEADINGS = ['Build', 'Release', 'VM / workers', 'Gotchas'] as const;
/** Where a fact goes when no model picked a heading for it. */
export const APP_NOTES_FALLBACK_SECTION = 'Other';
export const APP_NOTES_MAX_CHARS = 12_000;
export const APP_FACT_MAX_CHARS = 500;
/** A heading's longest name. */
export const APP_NOTES_SECTION_MAX = 60;
export const APP_NOTES_VERSIONS_KEPT = 50;
/** The Collectives page under the app's wiki page. */
export const APP_NOTES_PAGE_TITLE = 'Notes';
/** The first line of the Collectives copy. */
export const APP_NOTES_MIRROR_BANNER = '> Edited in OtherBench. This page is a read-only copy: changes made here are overwritten.';

/** What an app's notes look like when nothing has been saved. */
export function emptyAppNotesBody(): string {
  return APP_NOTES_HEADINGS.map((h) => `## ${h}`).join('\n\n') + '\n';
}

interface Section {
  heading: string;
  lines: string[];
}

interface NotesDoc {
  /** Lines before the first heading. */
  preamble: string[];
  sections: Section[];
}

const HEADING_RE = /^##\s+(.+?)\s*$/;

function parse(body: string): NotesDoc {
  const doc: NotesDoc = { preamble: [], sections: [] };
  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const heading = HEADING_RE.exec(raw);
    if (heading) doc.sections.push({ heading: heading[1]!, lines: [] });
    else (doc.sections[doc.sections.length - 1]?.lines ?? doc.preamble).push(raw);
  }
  return doc;
}

const trimBlank = (lines: string[]): string[] => {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start++;
  while (end > start && lines[end - 1]!.trim() === '') end--;
  return lines.slice(start, end);
};

function render(doc: NotesDoc): string {
  const blocks: string[] = [];
  const preamble = trimBlank(doc.preamble);
  if (preamble.length > 0) blocks.push(preamble.join('\n'));
  for (const s of doc.sections) {
    const lines = trimBlank(s.lines);
    blocks.push(lines.length > 0 ? `## ${s.heading}\n${lines.join('\n')}` : `## ${s.heading}`);
  }
  return blocks.join('\n\n') + '\n';
}

/** A fact's text for comparing: no bullet, single spaces, lower case. */
export function normaliseFact(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** A fact as a note line: one line, a bullet. */
export function factLine(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim().replace(/^[-*+]\s+/, '');
  return `- ${one}`;
}

/** The headings, in order. */
export function appNotesSections(body: string): string[] {
  return parse(body).sections.map((s) => s.heading);
}

/** Whether the notes hold any fact (anything but headings and blank lines). */
export function hasAppNotesContent(body: string): boolean {
  return body.split('\n').some((l) => l.trim() !== '' && !HEADING_RE.test(l));
}

/** Whether `fact` is already a line of the notes. */
export function notesContainFact(body: string, fact: string): boolean {
  const want = normaliseFact(fact);
  return want !== '' && body.split('\n').some((l) => !HEADING_RE.test(l) && normaliseFact(l) === want);
}

/** Why the notes can't be saved, or null. */
export function validateAppNotes(body: string): string | null {
  if (body.length > APP_NOTES_MAX_CHARS) return `App notes can be at most ${APP_NOTES_MAX_CHARS.toLocaleString('en-GB')} characters.`;
  return null;
}

/** Why `text` can't be a fact, or null. */
export function validateFact(text: string): string | null {
  if (text.trim() === '') return 'The fact is empty.';
  if (text.length > APP_FACT_MAX_CHARS) return `A fact can be at most ${APP_FACT_MAX_CHARS} characters.`;
  return null;
}

/** A heading as given, or the existing one it matches (case-insensitive). */
function findSection(doc: NotesDoc, name: string): Section | undefined {
  const want = name.trim().toLowerCase();
  return doc.sections.find((s) => s.heading.trim().toLowerCase() === want);
}

/** A heading name that is safe to write: one line, no leading #s, capped. Empty for nothing usable. */
export function cleanSectionName(name: string): string {
  return name.replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim().slice(0, APP_NOTES_SECTION_MAX);
}

export interface PlacedFact {
  body: string;
  /** The heading the line is under. */
  section: string;
  /** The line as written. */
  line: string;
  /** The line it replaced, or null. */
  replaced: string | null;
  /** False when the notes already held it: nothing changed, and there's nothing to take back. */
  added: boolean;
}

/**
 * The notes with `text` added as a line under `section` (made at the end when
 * it doesn't exist). `replaces` names an existing line it supersedes: that
 * line is removed, and when it was in the same section the new one takes its
 * place. A fact that is already there is left where it is.
 */
export function placeFact(body: string, text: string, section: string, replaces: string | null = null): PlacedFact {
  const doc = parse(body);
  const line = factLine(text);
  const existing = doc.sections.find((s) => s.lines.some((l) => normaliseFact(l) === normaliseFact(line)));
  if (existing) return { body: render(doc), section: existing.heading, line, replaced: null, added: false };
  const name = cleanSectionName(section) || APP_NOTES_FALLBACK_SECTION;
  let target = findSection(doc, name);
  if (!target) {
    target = { heading: name, lines: [] };
    doc.sections.push(target);
  }
  // Trimmed first, so the index of a replaced line in it is where the new one goes.
  target.lines = trimBlank(target.lines);
  let replaced: string | null = null;
  let at = -1;
  const old = replaces === null ? '' : normaliseFact(replaces);
  if (old !== '') {
    for (const s of [...doc.sections, { heading: '', lines: doc.preamble }]) {
      const i = s.lines.findIndex((l) => !HEADING_RE.test(l) && normaliseFact(l) === old);
      if (i === -1) continue;
      replaced = s.lines[i]!.trim();
      s.lines.splice(i, 1);
      if (s === target) at = i;
      break;
    }
  }
  const lines = target.lines;
  if (at === -1) target.lines = [...trimBlank(lines), line];
  else lines.splice(at, 0, line);
  return { body: render(doc), section: target.heading, line, replaced, added: true };
}

/** The notes with `line` moved under `toSection` (made when missing). Unchanged when the line isn't there. */
export function moveFact(body: string, line: string, toSection: string): string {
  const doc = parse(body);
  const want = normaliseFact(line);
  for (const s of doc.sections) {
    const i = s.lines.findIndex((l) => normaliseFact(l) === want);
    if (i === -1) continue;
    const [kept] = s.lines.splice(i, 1);
    const name = cleanSectionName(toSection) || APP_NOTES_FALLBACK_SECTION;
    let target = findSection(doc, name);
    if (!target) {
      target = { heading: name, lines: [] };
      doc.sections.push(target);
    }
    target.lines = [...trimBlank(target.lines), kept!.trim()];
    return render(doc);
  }
  return body;
}

/** The notes with `oldLine` rewritten as `text`, in place. Unchanged when the line isn't there. */
export function editFact(body: string, oldLine: string, text: string): string {
  const doc = parse(body);
  const want = normaliseFact(oldLine);
  for (const s of doc.sections) {
    const i = s.lines.findIndex((l) => normaliseFact(l) === want);
    if (i === -1) continue;
    s.lines[i] = factLine(text);
    return render(doc);
  }
  return body;
}

/**
 * The fact in a message typed with `#` (Claude Code's "remember"), or null
 * for an ordinary message: one line, starting with a single `#`. A markdown
 * heading (`## `) and anything over several lines are ordinary messages.
 */
export function factFromMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('#') || trimmed.startsWith('##') || trimmed.includes('\n')) return null;
  const fact = trimmed.slice(1).trim();
  return fact === '' ? null : fact;
}

// --- the offer tag ----------------------------------------------------------------

/** A model offers a fact by writing this on its own line; the user sees a Save card. */
const OFFER_RE = /<save-note(?:\s+section\s*=\s*"([^"\n]{0,80})")?\s*>([^<]{1,600}?)<\/save-note>/g;

export type OfferSegment = { type: 'text'; text: string } | { type: 'offer'; section: string; fact: string };

/** Whether `text` holds an offer tag, finished or still streaming. */
export function hasNoteOffer(text: string): boolean {
  return text.includes('<save-note');
}

/**
 * A reply's text split into its markdown and its offers. An offer tag still
 * being written (no closing tag yet) is left out, so a streaming reply never
 * shows half a tag.
 */
export function splitNoteOffers(text: string): OfferSegment[] {
  const out: OfferSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(OFFER_RE)) {
    const before = text.slice(last, m.index);
    if (before.trim() !== '') out.push({ type: 'text', text: before });
    out.push({ type: 'offer', section: cleanSectionName(m[1] ?? ''), fact: m[2]!.replace(/\s+/g, ' ').trim() });
    last = m.index + m[0].length;
  }
  let rest = text.slice(last);
  const open = rest.lastIndexOf('<save-note');
  if (open !== -1 && !rest.slice(open).includes('</save-note>')) rest = rest.slice(0, open);
  if (rest.trim() !== '') out.push({ type: 'text', text: rest });
  return out;
}

// --- prompts ------------------------------------------------------------------------

/**
 * The block an app's chats get in their system prompt: the notes, and how to
 * offer a fact. Without notes yet, only the offer guidance.
 */
export function appNotesPrompt(appName: string, body: string): string {
  const notes = hasAppNotesContent(body) ? `\n\nThe user's notes:\n\n${body.trim()}` : '\n\nThere are no notes yet.';
  return `# App notes: ${appName}

The user keeps notes on this app: standing facts such as how it is built and released, which machine or worker to use, and things to watch out for. They are current; follow them.${notes}

When you work out a lasting fact about this app that isn't in the notes (a build command that turned out to be needed, a release step, which worker or machine to use, a gotcha), you may offer it by writing it on its own line as:

<save-note section="Build">One short line stating the fact.</save-note>

Use one of the headings above, or a new short one. The user sees a Save button; nothing is saved unless they press it. Offer only facts that will still matter in a later chat, not progress on the current task; at most two in a reply; never one the notes already hold.`;
}

/** The utility call that files a fact: which heading, and which existing line it replaces. */
export function factPlacementPrompt(body: string, fact: string, sectionHint: string | null): string {
  const hint = sectionHint ? `\nThe user suggested the heading "${sectionHint}".` : '';
  return `You file facts into a short notes page about a software app. Here is the page:

<notes>
${body.trim()}
</notes>

The new fact:

<fact>
${fact}
</fact>
${hint}
Answer with JSON only, no prose and no code fence: {"section": "<heading>", "replaces": "<line>" | null}

- "section": the existing heading (exactly as written after "## ") the fact belongs under, or a new short heading (at most four words) if none fits.
- "replaces": an existing line, copied exactly, that the new fact makes out of date or contradicts (the same setting with a new value, say); null when it adds something new.`;
}

/** The model's placement, checked against the notes; null when it can't be used. */
export function parseFactPlacement(output: string, body: string): { section: string; replaces: string | null } | null {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { section, replaces } = value as Record<string, unknown>;
  if (typeof section !== 'string') return null;
  const name = cleanSectionName(section);
  if (name === '') return null;
  // Only a line that is really there: anything else would remove nothing, or the wrong thing.
  const replacing = typeof replaces === 'string' && notesContainFact(body, replaces) ? replaces : null;
  return { section: name, replaces: replacing };
}

/** The Collectives copy: the banner, then the notes. */
export function appNotesMirrorText(body: string): string {
  return `${APP_NOTES_MIRROR_BANNER}\n\n${body.trim()}\n`;
}

/** The notes without `line`. Unchanged when the line isn't there. */
export function removeFact(body: string, line: string): string {
  const doc = parse(body);
  const want = normaliseFact(line);
  for (const s of doc.sections) {
    const i = s.lines.findIndex((l) => normaliseFact(l) === want);
    if (i === -1) continue;
    s.lines.splice(i, 1);
    return render(doc);
  }
  return body;
}

// --- what the API answers --------------------------------------------------------

/** Where the Collectives copy stands, for the Notes tab. */
export type AppNotesMirror =
  | { state: 'off' }
  | { state: 'not-configured' }
  | { state: 'no-page' }
  /** Never saved, so there is nothing to copy. */
  | { state: 'nothing' }
  | { state: 'pending' }
  | { state: 'mirrored'; at: number; url: string | null }
  | { state: 'failed'; at: number; error: string };

export interface AppNotesView {
  notes: AppNotes;
  mirror: AppNotesMirror;
}

export interface FactSaved extends AppNotesView {
  fact: PlacedFact;
}

/** One row of `GET /api/apps/:id/notes/versions` (newest first). */
export interface AppNotesVersionSummary {
  id: string;
  createdAt: number;
  sourceChatId: string | null;
  length: number;
}
