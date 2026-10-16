import type { CanonMessage, Part, ProducedBy } from '../types/messages.js';
import { isAttachmentId } from './attachment-binding.js';
import { CLAUDE_REPLY_NAME, type ImportedChat, type ImportProfile } from './claude-import.js';

/**
 * Import from Cowork (spec 2026-10-09-claude-import-design, Cowork addendum):
 * Claude Desktop keeps each Cowork session on the machine, as a metadata file
 * and a Claude Code transcript (JSONL), never in the claude.ai export. Pure:
 * the server finds and reads the files, and stores the images.
 *
 * A transcript writes each piece of a turn as its own line (a reply comes a
 * content block at a time, a tool result as a "user" line), linked by
 * `parentUuid`. Here a prompt becomes a user message and everything up to the
 * next prompt becomes one assistant message, as OtherBench records its own turns.
 * Only the branch that ends at the transcript's last line is kept; retries
 * and resumes leave others behind.
 */

export const UNTITLED_COWORK_SESSION = 'Untitled Cowork session';
/** Longest title made from a session's first prompt, as for OtherBench's own titles. */
const DERIVED_TITLE_MAX = 48;
/** Images stored as attachments: the raster types OtherBench serves (attachments.ts's allowlist). */
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** One Cowork session as read from disk. */
export interface CoworkSessionFiles {
  /** `local_<id>.json`: title, times, model, space. */
  meta: unknown;
  /** The session's Claude Code transcript (JSONL). */
  transcript: string;
  /** The space the session is in, from `remote-session-spaces.json`, when its metadata doesn't say. */
  spaceId: string | null;
}

/** An image pasted into a session: its bytes go to the blob store, its part names `attachmentId`. */
export interface ImportedImage {
  attachmentId: string;
  messageId: string;
  mime: string;
  /** Base64, as the transcript holds it. */
  data: string;
  filename: string;
}

export interface CoworkChat extends ImportedChat {
  spaceId: string | null;
  images: ImportedImage[];
}

export interface CoworkStats {
  sessions: number;
  /** Sessions with nothing to import. */
  emptySessions: number;
  /** Sessions without an id or transcript. */
  malformedSessions: number;
  messages: number;
  images: number;
  /** Transcript lines on branches other than the one the session ended on. */
  otherBranchLines: number;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function time(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

export function emptyCoworkStats(): CoworkStats {
  return { sessions: 0, emptySessions: 0, malformedSessions: 0, messages: 0, images: 0, otherBranchLines: 0 };
}

interface Line {
  uuid: string | null;
  parent: string | null;
  type: string;
  raw: Obj;
}

function readLines(transcript: string): Line[] {
  const lines: Line[] = [];
  for (const text of transcript.split('\n')) {
    if (!text.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isObj(raw)) continue;
    lines.push({ uuid: str(raw['uuid']), parent: str(raw['parentUuid']), type: str(raw['type']) ?? '', raw });
  }
  return lines;
}

/** The uuids on the branch that ends at the last user or assistant line, or null when the transcript has no links to follow. */
function mainBranch(lines: Line[]): Set<string> | null {
  const turns = lines.filter((l) => l.type === 'user' || l.type === 'assistant');
  const last = turns.at(-1);
  if (!last?.uuid || !lines.some((l) => l.parent !== null)) return null;
  const parentOf = new Map<string, string | null>();
  for (const l of lines) if (l.uuid) parentOf.set(l.uuid, l.parent);
  const branch = new Set<string>();
  for (let at: string | null | undefined = last.uuid; at && !branch.has(at); at = parentOf.get(at)) branch.add(at);
  return branch;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const item of list(content)) {
    if (!isObj(item)) continue;
    const type = str(item['type']);
    if (type === 'text') parts.push(str(item['text']) ?? '');
    else if (type === 'image') parts.push('[An image, not imported]');
    else if (type) parts.push(`[${type}]`);
  }
  return parts.join('\n');
}

/** Builds one Cowork session's chat, or null when there's nothing in it (counted). */
export function planCoworkSession(files: CoworkSessionFiles, profile: ImportProfile, stats: CoworkStats): CoworkChat | null {
  stats.sessions++;
  const meta = files.meta;
  const chatId = isObj(meta) ? str(meta['sessionId']) : null;
  if (!isObj(meta) || !chatId) {
    stats.malformedSessions++;
    return null;
  }
  const lines = readLines(files.transcript);
  const branch = mainBranch(lines);
  const sessionModel = str(meta['model']);
  const created = time(meta['createdAt'], 0);

  const messages: CanonMessage[] = [];
  const images: ImportedImage[] = [];
  /** Tool calls by id, with the message holding them, so a result lands next to its call. */
  const calls = new Map<string, { message: CanonMessage; name: string; answered: boolean }>();
  let content = false;

  const last = (): CanonMessage | undefined => messages.at(-1);
  const add = (role: 'user' | 'assistant', id: string, at: number, model: string | null): CanonMessage => {
    const producedBy: ProducedBy | null = role === 'assistant' ? { profileId: profile.id, profileName: CLAUDE_REPLY_NAME, connectionId: profile.connectionId, modelId: model ?? sessionModel ?? 'cowork' } : null;
    const m: CanonMessage = { id, chatId, parentId: last()?.id ?? null, role, parts: [], status: 'complete', error: null, producedBy, createdAt: at };
    messages.push(m);
    return m;
  };

  for (const line of lines) {
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    if (line.raw['isSidechain'] === true || line.raw['isMeta'] === true) continue;
    const message = isObj(line.raw['message']) ? line.raw['message'] : null;
    if (!message || !line.uuid) continue;
    const at = time(line.raw['timestamp'], created);
    const blocks = typeof message['content'] === 'string' ? [{ type: 'text', text: message['content'] }] : list(message['content']);
    const onBranch = branch === null || branch.has(line.uuid);

    if (line.type === 'assistant') {
      if (!onBranch) {
        stats.otherBranchLines++;
        continue;
      }
      let reply = last();
      // Claude Code names its own lines (an API error, an interruption) "<synthetic>": the session's model made the rest.
      const model = str(message['model']);
      if (!reply || reply.role !== 'assistant') reply = add('assistant', line.uuid, at, model === '<synthetic>' ? null : model);
      for (const b of blocks) {
        if (!isObj(b)) continue;
        const type = str(b['type']);
        if (type === 'text' && str(b['text'])?.trim()) reply.parts.push({ type: 'text', text: str(b['text'])! });
        else if (type === 'thinking' && str(b['thinking'])?.trim()) reply.parts.push({ type: 'reasoning', text: str(b['thinking'])! });
        else if (type === 'tool_use' && str(b['id'])) {
          const name = str(b['name']) || 'tool';
          reply.parts.push({ type: 'tool-call', id: str(b['id'])!, name, args: b['input'] ?? {} });
          calls.set(str(b['id'])!, { message: reply, name, answered: false });
        }
      }
      content ||= reply.parts.length > 0;
      continue;
    }

    // A user line: tool results go to their calls (wherever the branch split); anything else is a prompt.
    const prompt: Part[] = [];
    const pasted: Omit<ImportedImage, 'messageId'>[] = [];
    let n = 0;
    for (const b of blocks) {
      if (!isObj(b)) continue;
      const type = str(b['type']);
      if (type === 'tool_result') {
        const call = calls.get(str(b['tool_use_id']) ?? '');
        if (!call || call.answered) continue;
        call.answered = true;
        call.message.parts.push({ type: 'tool-result', id: str(b['tool_use_id'])!, name: call.name, result: toolResultText(b['content']), isError: b['is_error'] === true });
      } else if (type === 'text' && str(b['text'])?.trim()) {
        prompt.push({ type: 'text', text: str(b['text'])! });
      } else if (type === 'image') {
        const source = isObj(b['source']) ? b['source'] : null;
        const mime = str(source?.['media_type'])?.toLowerCase() ?? '';
        const data = str(source?.['data']);
        // The id is checked against the one rule every reader applies, so an image is never stored under an id that replay and sync would then refuse.
        const attachmentId = `${line.uuid}:image:${n + 1}`;
        if (source?.['type'] === 'base64' && data && IMAGE_TYPES.has(mime) && isAttachmentId(attachmentId)) {
          n++;
          pasted.push({ attachmentId, mime, data, filename: `image-${n}.${mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length)}` });
          prompt.push({ type: 'image', attachmentId, mime });
        } else {
          prompt.push({ type: 'text', text: '[An image, not imported]' });
        }
      } else if (type === 'document') {
        prompt.push({ type: 'text', text: `[A document, not imported${str(b['title']) ? `: ${str(b['title'])}` : ''}]` });
      }
    }
    if (prompt.length === 0) continue;
    if (!onBranch) {
      stats.otherBranchLines++;
      continue;
    }
    // Prompts sent one after another with no reply between them are one message.
    const previous = last();
    const target = previous && previous.role === 'user' ? previous : add('user', line.uuid, at, null);
    target.parts.push(...prompt);
    images.push(...pasted.map((p) => ({ ...p, messageId: target.id })));
    content = true;
  }

  // A call with no result gets an error result straight after it, as a provider replaying the chat expects.
  for (const [id, call] of calls) {
    if (call.answered) continue;
    const at = call.message.parts.findIndex((p) => p.type === 'tool-call' && p.id === id);
    call.message.parts.splice(at + 1, 0, { type: 'tool-result', id, name: call.name, result: 'No result in the Cowork transcript.', isError: true });
  }

  if (!content) {
    stats.emptySessions++;
    return null;
  }
  for (const m of messages) if (m.parts.length === 0) m.parts.push({ type: 'notice', text: 'Empty in the Cowork transcript.' });
  stats.messages += messages.length;
  stats.images += images.length;

  const byTime = (a: CanonMessage, b: CanonMessage): number => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const newest = [...messages].sort(byTime).at(-1)!;
  // The first thing the user wrote, not one of the import's own notes.
  const firstText = messages.find((m) => m.role === 'user')?.parts.find((p) => p.type === 'text' && !/^\[(An image|A document), not imported/.test(p.text));
  const firstLine = (firstText?.type === 'text' ? firstText.text : '').split('\n').find((l) => l.trim())?.trim().slice(0, DERIVED_TITLE_MAX) ?? '';
  const title = str(meta['title'])?.trim() || firstLine || UNTITLED_COWORK_SESSION;
  return {
    id: chatId,
    title: title.slice(0, 200),
    createdAt: created || messages[0]!.createdAt,
    updatedAt: time(meta['lastActivityAt'], newest.createdAt),
    messages,
    headMessageId: messages.at(-1)!.id,
    latestMessageId: newest.id,
    spaceId: str(meta['spaceId']) ?? files.spaceId,
    images,
  };
}
