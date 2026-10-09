import type { CanonMessage, Part, ProducedBy } from '../types/messages.js';
import { MAX_ARTIFACT_BYTES } from './artifacts.js';
import { fenced } from './export.js';

/**
 * Import from claude.ai (spec 2026-10-09-claude-import-design): turns the
 * parts of a claude.ai data export, already read and parsed, into what Grunt
 * stores. Pure: the server reads the files and writes the plan.
 *
 * The export format isn't documented, so every field is checked before it's
 * used and anything unexpected is skipped and counted rather than trusted.
 * claude.ai's uuids are kept as Grunt ids, which is what makes a second
 * import of the same export skip what is already there.
 */

/** claude.ai's parent id for the first message of a conversation. */
export const CLAUDE_ROOT_PARENT = '00000000-0000-4000-8000-000000000000';
/** How imported replies are labelled: `producedBy.profileName` and `modelId`. */
export const CLAUDE_REPLY_NAME = 'Claude';
export const CLAUDE_REPLY_MODEL = 'claude.ai';
export const UNTITLED_CHAT = 'Untitled chat';
export const UNTITLED_PROJECT = 'Untitled claude.ai project';
/** Longest title made from a chat's first message, as for Grunt's own titles. */
const DERIVED_TITLE_MAX = 48;
const TITLE_MAX = 200;
const DOC_NAME_MAX = 100;

/** The export can't be imported at all (as opposed to a part of it being skipped). */
export class ClaudeExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeExportError';
  }
}

/** The export's parts as read from disk: parsed JSON, not yet checked. */
export interface ClaudeExportFiles {
  /** `conversations.json`. */
  conversations: unknown;
  /** Each `projects/*.json`. */
  projects: unknown[];
  /** Each `memories/*.json` (one per account). */
  memories: unknown[];
  /** Each published artifact ("frame"): its `artifact.json` and its versions' HTML by version id. */
  artifacts: { meta: unknown; html: Record<string, string> }[];
}

/** The profile imported chats belong to; assistant replies name it in `producedBy`. */
export interface ImportProfile {
  id: string;
  connectionId: string;
}

export interface ImportedArtifact {
  /** The Grunt artifact's id. */
  id: string;
  slug: string;
  /** Oldest first; numbered 1, 2, … in this order. */
  versions: { id: string; title: string; content: string; createdAt: number }[];
}

export interface ImportedChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Parents before children. */
  messages: CanonMessage[];
  /** The newest leaf: the branch the chat opens on. */
  headMessageId: string | null;
  /** The newest message by time, then id (as `MessageRepo.latestId` picks it): both memory cursors start here. */
  latestMessageId: string | null;
  /** Only on a published artifact's chat. */
  artifact?: ImportedArtifact;
}

export interface ImportedDoc {
  /** A safe file name, unique within the project (ASCII case-insensitive). */
  name: string;
  content: string;
}

export interface ImportedProject {
  id: string;
  name: string;
  description: string;
  instructions: string;
  createdAt: number;
  updatedAt: number;
  docs: ImportedDoc[];
  /** claude.ai's notes about the project (its project memory, then its memory files), '' when none. */
  memory: string;
}

export interface ImportedMemory {
  /** What About you is written from: everything about the user, most important first. '' when none. */
  about: string;
  /** What the learned note is folded from. '' when none. */
  note: string;
  /** Every memory file verbatim, plus the conversations memory, for the archive folder. */
  files: { path: string; content: string }[];
}

export interface ImportStats {
  conversations: number;
  /** Conversations with no messages, or whose messages all came through blank (only images or nothing at all). */
  emptyConversations: number;
  /** Conversations without an id or message list. */
  malformedConversations: number;
  messages: number;
  /** Chats with more than one branch (an edit or a regenerated reply). */
  branchedChats: number;
  /** Messages whose parent wasn't in the export, made roots. */
  orphanMessages: number;
  /** Messages without an id or sender, left out. */
  malformedMessages: number;
  /** Images and files named in a message whose bytes the export doesn't have. */
  filesNotIncluded: number;
  /** Tool calls with no result, given an error result. */
  missingToolResults: number;
  /** Blocks left out, by claude.ai block type ("user tool_result" for a tool result in a user message). */
  dropped: Record<string, number>;
  projectsSkipped: number;
  artifactsSkipped: number;
  artifactVersionsSkipped: number;
}

export interface ImportPlan {
  chats: ImportedChat[];
  /** One chat per published artifact. */
  artifactChats: ImportedChat[];
  projects: ImportedProject[];
  memory: ImportedMemory;
  stats: ImportStats;
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

/** An ISO time as epoch milliseconds, or `fallback` when it isn't one. */
function time(v: unknown, fallback: number): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

const byTime = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function emptyStats(): ImportStats {
  return {
    conversations: 0,
    emptyConversations: 0,
    malformedConversations: 0,
    messages: 0,
    branchedChats: 0,
    orphanMessages: 0,
    malformedMessages: 0,
    filesNotIncluded: 0,
    missingToolResults: 0,
    dropped: {},
    projectsSkipped: 0,
    artifactsSkipped: 0,
    artifactVersionsSkipped: 0,
  };
}

function drop(stats: ImportStats, kind: string): void {
  stats.dropped[kind] = (stats.dropped[kind] ?? 0) + 1;
}

/** The first line of `text`, cut to `max` characters, or '' when there is none. */
function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return line.length > max ? line.slice(0, max).trimEnd() : line;
}

function notice(text: string): Part {
  return { type: 'notice', text };
}

function notIncluded(name: string | null): Part {
  return notice(`Not included in the claude.ai export: ${name && name.trim() ? name.trim() : 'a file'}`);
}

/** A tool result's content as text: what was said, what was found, what was made. Page text from searches is left out. */
function resultText(block: Obj): string {
  const lines: string[] = [];
  for (const raw of list(block['content'])) {
    if (!isObj(raw)) continue;
    const type = str(raw['type']);
    if (type === 'text') {
      const text = str(raw['text']);
      if (text) lines.push(text);
    } else if (type === 'knowledge') {
      const title = str(raw['title'])?.trim() || 'Untitled';
      const url = str(raw['url']);
      lines.push(url ? `${title} — ${url}` : title);
    } else if (type === 'local_resource') {
      const name = str(raw['name']) ?? 'a file';
      const path = str(raw['file_path']);
      lines.push(path ? `File: ${name} (${path})` : `File: ${name}`);
    } else if (type === 'image') {
      lines.push('[An image, not included in the claude.ai export]');
    } else if (type === 'image_gallery') {
      const n = list(raw['images']).length;
      lines.push(`[${n} image${n === 1 ? '' : 's'}, not included in the claude.ai export]`);
    } else if (type) {
      lines.push(`[${type}]`);
    }
  }
  if (lines.length === 0) {
    const message = str(block['message']);
    if (message) lines.push(message);
  }
  return lines.join('\n');
}

interface PendingCall {
  id: string;
  name: string;
  /** Where its result goes if none comes: right after the call. */
  index: number;
  answered: boolean;
}

/**
 * One claude.ai message's parts. Tool results are paired with their calls by
 * id; about one call in sixteen has no id, so a result without one takes the
 * oldest unanswered call of the same name (or any name when it has none). A
 * call left unanswered gets an error result, so a provider replaying the chat
 * never sees a call without one.
 */
function messageParts(raw: Obj, role: 'user' | 'assistant', messageId: string, stats: ImportStats): Part[] {
  const parts: Part[] = [];
  const calls: PendingCall[] = [];
  const fileNames = new Map<string, string | null>();
  for (const f of list(raw['files'])) {
    if (!isObj(f)) continue;
    const uuid = str(f['file_uuid']);
    if (uuid) fileNames.set(uuid, str(f['file_name']));
  }
  const named = new Set<string>();
  let generated = 0;

  for (const block of list(raw['content'])) {
    if (!isObj(block)) continue;
    const type = str(block['type']) ?? 'unknown';
    if (type === 'text') {
      const text = str(block['text']);
      if (text && text.trim()) parts.push({ type: 'text', text });
    } else if (type === 'thinking') {
      const text = str(block['thinking']);
      if (text && text.trim()) parts.push({ type: 'reasoning', text });
    } else if (type === 'tool_use' && role === 'assistant') {
      const id = str(block['id']) ?? `${messageId}:call:${++generated}`;
      const name = str(block['name']) || 'tool';
      parts.push({ type: 'tool-call', id, name, args: block['input'] ?? {} });
      calls.push({ id, name, index: parts.length - 1, answered: false });
    } else if (type === 'tool_result' && role === 'assistant') {
      const wanted = str(block['tool_use_id']);
      const name = str(block['name']);
      const call = wanted
        ? calls.find((c) => c.id === wanted && !c.answered)
        : (calls.find((c) => !c.answered && (!name || c.name === name)) ?? calls.find((c) => !c.answered));
      if (call) call.answered = true;
      parts.push({
        type: 'tool-result',
        id: call?.id ?? wanted ?? `${messageId}:result:${++generated}`,
        name: name || call?.name || 'tool',
        result: resultText(block),
        isError: block['is_error'] === true,
      });
    } else if (type === 'image' || type === 'document') {
      const uuid = str(block['file_uuid']);
      if (uuid) named.add(uuid);
      parts.push(notIncluded((uuid ? fileNames.get(uuid) : null) ?? str(block['title'])));
      stats.filesNotIncluded++;
    } else {
      drop(stats, role === 'user' && (type === 'tool_result' || type === 'tool_use') ? `user ${type}` : type);
    }
  }

  // Unanswered calls get their error result straight after them, last first so the indexes hold.
  for (const call of calls.filter((c) => !c.answered).reverse()) {
    parts.splice(call.index + 1, 0, { type: 'tool-result', id: call.id, name: call.name, result: 'No result in the claude.ai export.', isError: true });
    stats.missingToolResults++;
  }

  for (const a of list(raw['attachments'])) {
    if (!isObj(a)) continue;
    const content = str(a['extracted_content']);
    const name = str(a['file_name'])?.trim() || 'pasted text';
    if (content && content.trim()) {
      parts.push({ type: 'text', text: `**Attached: ${name}**\n\n${fenced(content)}` });
    } else {
      parts.push(notIncluded(name));
      stats.filesNotIncluded++;
    }
  }

  for (const [uuid, name] of fileNames) {
    if (named.has(uuid)) continue;
    parts.push(notIncluded(name));
    stats.filesNotIncluded++;
  }

  if (parts.length === 0) parts.push(notice('Empty in the claude.ai export.'));
  return parts;
}

/** Builds one conversation's chat, or null when it has no messages (counted). */
function planConversation(raw: unknown, profile: ImportProfile, stats: ImportStats): ImportedChat | null {
  stats.conversations++;
  if (!isObj(raw) || !str(raw['uuid']) || !Array.isArray(raw['chat_messages'])) {
    stats.malformedConversations++;
    return null;
  }
  const chatId = str(raw['uuid'])!;
  const chatCreated = time(raw['created_at'], 0);
  const producedBy: ProducedBy = { profileId: profile.id, profileName: CLAUDE_REPLY_NAME, connectionId: profile.connectionId, modelId: CLAUDE_REPLY_MODEL };

  // Read every message first, then link them: claude.ai lists parents first, but nothing promises it.
  const found: { raw: Obj; id: string; role: 'user' | 'assistant'; parent: string | null; createdAt: number }[] = [];
  for (const m of raw['chat_messages'] as unknown[]) {
    const id = isObj(m) ? str(m['uuid']) : null;
    const sender = isObj(m) ? str(m['sender']) : null;
    if (!isObj(m) || !id || (sender !== 'human' && sender !== 'assistant')) {
      stats.malformedMessages++;
      continue;
    }
    const parent = str(m['parent_message_uuid']);
    found.push({ raw: m, id, role: sender === 'human' ? 'user' : 'assistant', parent: parent && parent !== CLAUDE_ROOT_PARENT ? parent : null, createdAt: time(m['created_at'], chatCreated) });
  }
  if (found.length === 0) {
    stats.emptyConversations++;
    return null;
  }

  const ids = new Set(found.map((m) => m.id));
  const children = new Map<string | null, typeof found>();
  for (const m of found) {
    let parent = m.parent;
    if (parent !== null && (!ids.has(parent) || parent === m.id)) {
      stats.orphanMessages++;
      parent = null;
    }
    m.parent = parent;
    const siblings = children.get(parent) ?? [];
    siblings.push(m);
    children.set(parent, siblings);
  }

  // Walk from the roots so parents always come first; anything unreachable is part of a cycle.
  const messages: CanonMessage[] = [];
  const queue = [...(children.get(null) ?? [])].sort(byTime);
  let branched = false;
  while (queue.length > 0) {
    const m = queue.shift()!;
    const kids = [...(children.get(m.id) ?? [])].sort(byTime);
    if (kids.length > 1) branched = true;
    queue.push(...kids);
    const siblings = (children.get(m.parent) ?? []).filter((s) => s.role === 'assistant').sort(byTime);
    const regenerated = m.role === 'assistant' && siblings.length > 1 && siblings[0]!.id !== m.id;
    messages.push({
      id: m.id,
      chatId,
      parentId: m.parent,
      role: m.role,
      parts: messageParts(m.raw, m.role, m.id, stats),
      status: 'complete',
      error: null,
      producedBy: m.role === 'assistant' ? (regenerated ? { ...producedBy, regenerated: true } : producedBy) : null,
      createdAt: m.createdAt,
    });
  }
  // Some conversations come through with every message blank: nothing to import.
  if (messages.every((m) => m.parts.every((p) => p.type === 'notice'))) {
    stats.emptyConversations++;
    return null;
  }
  if ((children.get(null)?.length ?? 0) > 1) branched = true;
  stats.malformedMessages += found.length - messages.length;
  stats.messages += messages.length;
  if (branched) stats.branchedChats++;

  const parentIds = new Set(messages.map((m) => m.parentId));
  const leaves = messages.filter((m) => !parentIds.has(m.id)).sort(byTime);
  const newest = [...messages].sort(byTime).at(-1) ?? null;
  // The first thing the user said, or (when that message came through empty) the first thing said at all.
  const textOf = (m: CanonMessage): string => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
  const firstText = textOf(messages.find((m) => m.role === 'user') ?? messages[0]!) || (messages.map(textOf).find((t) => t.trim()) ?? '');
  const name = str(raw['name'])?.trim() ?? '';
  return {
    id: chatId,
    title: (name ? name.slice(0, TITLE_MAX) : firstLine(firstText, DERIVED_TITLE_MAX)) || UNTITLED_CHAT,
    createdAt: chatCreated || (messages[0]?.createdAt ?? 0),
    updatedAt: time(raw['updated_at'], newest?.createdAt ?? chatCreated),
    messages,
    headMessageId: leaves.at(-1)?.id ?? null,
    latestMessageId: newest?.id ?? null,
  };
}

/** A name safe as a file name on every OS: no path, no reserved characters, never empty. */
export function safeFileName(raw: string, fallback: string, max = DOC_NAME_MAX): string {
  const base = raw.split(/[\\/]/).at(-1) ?? '';
  const cleaned = base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '');
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : fallback;
}

/** `name` made unique against `taken` (ASCII case-insensitive) with -2, -3 before the extension. */
function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

interface MemorySource {
  conversations: string;
  files: { path: string; content: string }[];
  byProject: Map<string, string>;
}

/**
 * The first of each id: a folder can hold the same export twice (the ZIPs and
 * what was extracted from them). Items without an id are kept, to be counted
 * as malformed.
 */
function firstOfEach<T>(items: T[], idOf: (item: T) => string | null): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = idOf(item);
    if (id === null) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const uuidOf = (v: unknown): string | null => (isObj(v) ? str(v['uuid']) : null);

function readMemories(raws: unknown[]): MemorySource {
  const source: MemorySource = { conversations: '', files: [], byProject: new Map() };
  for (const raw of firstOfEach(raws, (v) => (isObj(v) ? str(v['account_uuid']) : null))) {
    if (!isObj(raw)) continue;
    const conversations = str(raw['conversations_memory'])?.trim();
    if (conversations) source.conversations = source.conversations ? `${source.conversations}\n\n${conversations}` : conversations;
    for (const f of list(raw['memory_files'])) {
      if (!isObj(f)) continue;
      const path = str(f['path']);
      const content = str(f['content']);
      if (path && content && content.trim()) source.files.push({ path: path.startsWith('/') ? path : `/${path}`, content });
    }
    const projects = raw['project_memories'];
    if (isObj(projects)) {
      for (const [id, body] of Object.entries(projects)) {
        if (typeof body === 'string' && body.trim()) source.byProject.set(id, body.trim());
      }
    }
  }
  return source;
}

function section(title: string, body: string): string {
  return `### ${title}\n\n${body.trim()}`;
}

/** The `description:` line of a memory file's front matter, unquoted, or null. */
function frontMatterDescription(content: string): string | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(content.replace(/\r\n?/g, '\n'));
  const line = match?.[1]?.split('\n').find((l) => l.startsWith('description:'));
  if (!line) return null;
  const value = line.slice('description:'.length).trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  return value || null;
}

function planProject(raw: unknown, memory: MemorySource, stats: ImportStats): ImportedProject | null {
  const id = isObj(raw) ? str(raw['uuid']) : null;
  if (!isObj(raw) || !id) {
    stats.projectsSkipped++;
    return null;
  }
  const taken = new Set<string>();
  const docs: ImportedDoc[] = [];
  list(raw['docs']).forEach((d, i) => {
    if (!isObj(d)) return;
    const content = str(d['content']);
    if (!content || !content.trim()) return;
    docs.push({ name: uniqueName(safeFileName(str(d['filename']) ?? '', `doc-${i + 1}.md`), taken), content });
  });
  const prefix = `/projects/${id}/`;
  const files = memory.files.filter((f) => f.path.startsWith(prefix));
  const notes = [memory.byProject.get(id) ? section('Project memory', memory.byProject.get(id)!) : null, ...files.map((f) => section(f.path.slice(prefix.length), f.content))].filter((s): s is string => s !== null);
  const name = str(raw['name'])?.trim() ?? '';
  const instructions = str(raw['prompt_template'])?.trim() ?? '';
  if (!name && !instructions && docs.length === 0 && notes.length === 0) {
    stats.projectsSkipped++;
    return null;
  }
  const index = files.find((f) => f.path === `${prefix}index.md`);
  const created = time(raw['created_at'], 0);
  return {
    id,
    name: name.slice(0, TITLE_MAX) || UNTITLED_PROJECT,
    description: str(raw['description'])?.trim() || (index ? frontMatterDescription(index.content) : null) || '',
    instructions,
    createdAt: created,
    updatedAt: time(raw['updated_at'], created),
    docs,
    memory: notes.join('\n\n'),
  };
}

/** A slug for the artifact tool: lower-case letters, digits and dashes, 1-64 long. */
function slugOf(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'artifact';
}

function planArtifact(raw: { meta: unknown; html: Record<string, string> }, profile: ImportProfile, stats: ImportStats): ImportedChat | null {
  const meta = raw.meta;
  const id = isObj(meta) ? str(meta['id']) : null;
  if (!isObj(meta) || !id) {
    stats.artifactsSkipped++;
    return null;
  }
  const versions: (ImportedArtifact['versions'][number] & { sourceId: string })[] = [];
  for (const v of list(meta['versions'])) {
    const versionId = isObj(v) ? str(v['id']) : null;
    const content = versionId !== null ? raw.html[versionId] : undefined;
    if (!isObj(v) || versionId === null || content === undefined || Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) {
      stats.artifactVersionsSkipped++;
      continue;
    }
    versions.push({ id: `${id}:${versionId}`, sourceId: versionId, title: str(v['title'])?.trim() || 'Untitled artifact', content, createdAt: time(v['created_at'], 0) });
  }
  if (versions.length === 0) {
    stats.artifactsSkipped++;
    return null;
  }
  versions.sort(byTime);
  const activeId = str(meta['active_version']);
  const activeIndex = Math.max(0, versions.findIndex((v) => v.sourceId === activeId));
  const active = versions[activeIndex]!;
  const newest = versions.at(-1)!;
  const slug = slugOf(active.title);
  const artifactId = `${id}:artifact`;
  const messageId = `${id}:message`;
  const callId = `${id}:card`;
  const n = versions.length;
  const message: CanonMessage = {
    id: messageId,
    chatId: id,
    parentId: null,
    role: 'assistant',
    parts: [
      { type: 'text', text: `Published artifact imported from claude.ai, with ${n} version${n === 1 ? '' : 's'}.` },
      { type: 'tool-call', id: callId, name: 'artifact', args: { command: 'create', slug, title: active.title, kind: 'html' } },
      {
        type: 'tool-result',
        id: callId,
        name: 'artifact',
        result: JSON.stringify({ ok: true, command: 'create', artifactId, slug, kind: 'html', title: active.title, versionId: active.id, number: activeIndex + 1 }),
        isError: false,
      },
    ],
    status: 'complete',
    error: null,
    producedBy: { profileId: profile.id, profileName: CLAUDE_REPLY_NAME, connectionId: profile.connectionId, modelId: CLAUDE_REPLY_MODEL },
    createdAt: newest.createdAt,
  };
  return {
    id,
    title: active.title.slice(0, TITLE_MAX),
    createdAt: versions[0]!.createdAt,
    updatedAt: time(meta['updated_at'], newest.createdAt),
    messages: [message],
    headMessageId: messageId,
    latestMessageId: messageId,
    artifact: { id: artifactId, slug, versions: versions.map(({ sourceId: _sourceId, ...v }) => v) },
  };
}

/** Memory files that describe the user, in the order About you should weigh them. */
function aboutFiles(files: MemorySource['files']): MemorySource['files'] {
  const rank = (path: string): number => (path === '/profile.md' ? 0 : path.startsWith('/people/') ? 1 : path.startsWith('/topics/') ? 2 : 3);
  return files
    .filter((f) => !f.path.startsWith('/projects/') && !f.path.startsWith('/areas/') && f.path !== '/preferences.md')
    .sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function planMemory(memory: MemorySource): ImportedMemory {
  const conversations = memory.conversations ? [section('What claude.ai remembered from conversations', memory.conversations)] : [];
  const pick = (path: string) => memory.files.filter((f) => f.path === path).map((f) => section(f.path, f.content));
  const about = [...conversations, ...aboutFiles(memory.files).map((f) => section(f.path, f.content))];
  const note = [...pick('/preferences.md'), ...conversations, ...pick('/profile.md')];
  const files = [...(memory.conversations ? [{ path: '/conversations-memory.md', content: memory.conversations }] : []), ...memory.files];
  for (const [id, body] of memory.byProject) files.push({ path: `/project-memories/${id}.md`, content: body });
  return { about: about.join('\n\n'), note: note.join('\n\n'), files };
}

/**
 * The whole import, planned. Throws `ClaudeExportError` only when the
 * conversations aren't a list; everything smaller is skipped and counted.
 */
export function planClaudeImport(files: ClaudeExportFiles, profile: ImportProfile): ImportPlan {
  if (!Array.isArray(files.conversations)) {
    throw new ClaudeExportError("This doesn't look like a claude.ai export: conversations.json isn't a list of conversations.");
  }
  const stats = emptyStats();
  const chats = firstOfEach(files.conversations, uuidOf)
    .map((c) => planConversation(c, profile, stats))
    .filter((c): c is ImportedChat => c !== null);
  const memory = readMemories(files.memories);
  const projects = firstOfEach(files.projects, uuidOf)
    .map((p) => planProject(p, memory, stats))
    .filter((p): p is ImportedProject => p !== null);
  const artifactChats = firstOfEach(files.artifacts, (a) => (isObj(a.meta) ? str(a.meta['id']) : null))
    .map((a) => planArtifact(a, profile, stats))
    .filter((c): c is ImportedChat => c !== null);
  return { chats, artifactChats, projects, memory: planMemory(memory), stats };
}
