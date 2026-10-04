import type { Attachment, Chat, UsageRecord } from '../ports/store.js';
import type { CanonMessage, Part } from '../types/messages.js';
import { activePath, extendToTip, isCompareSet, siblingsOf } from './tree.js';

/**
 * Chat export (#820): the conversation as it is shown, as Markdown to read or
 * share, or the whole message tree as JSON for a full-fidelity copy. Pure
 * functions over what the store holds; routes/chats.ts serves them.
 */

/** The `format` field of a JSON export, so a reader can recognise one. */
export const CHAT_EXPORT_FORMAT = 'grunt-chat-export';
export const CHAT_EXPORT_VERSION = 1;

/** Tool arguments and results longer than this are cut in the Markdown export (the JSON keeps them whole). */
const MARKDOWN_TOOL_MAX_CHARS = 4000;

export interface ChatExportJson {
  format: typeof CHAT_EXPORT_FORMAT;
  version: typeof CHAT_EXPORT_VERSION;
  exportedAt: string;
  chat: Chat;
  /** The messages shown in the app, root first: the branch the head is on, through to its end. */
  shownPath: string[];
  /** Every message in the chat, every branch and compare variant included. */
  messages: CanonMessage[];
  usage: UsageRecord[];
  /** What each attachment part refers to. Content is not included. */
  attachments: Pick<Attachment, 'id' | 'messageId' | 'filename' | 'mime' | 'size'>[];
}

/**
 * The messages the thread shows: the head's branch from the root, carried on
 * to the end of that branch the way the app displays it. With no head, the
 * newest root's branch. Empty for an empty chat.
 */
export function shownPath(messages: CanonMessage[], headMessageId: string | null): CanonMessage[] {
  let path: CanonMessage[] = [];
  if (headMessageId) {
    try {
      path = activePath(messages, headMessageId);
    } catch {
      path = [];
    }
  }
  if (path.length === 0) {
    const roots = messages.filter((m) => m.parentId === null).sort((a, b) => a.createdAt - b.createdAt);
    const newest = roots.at(-1);
    if (!newest) return [];
    path = [newest];
  }
  return [...path, ...extendToTip(messages, path.at(-1)!.id)];
}

/** A fenced code block whose fence is longer than any run of backticks inside it, so content can't close it early. */
function fenced(content: string, lang = ''): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${content}\n${fence}`;
}

function cut(text: string): string {
  return text.length > MARKDOWN_TOOL_MAX_CHARS ? `${text.slice(0, MARKDOWN_TOOL_MAX_CHARS)}\n… (${text.length - MARKDOWN_TOOL_MAX_CHARS} more characters in the JSON export)` : text;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function partToMarkdown(part: Part, attachmentName: (id: string) => string | null): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'reasoning':
      return `<details>\n<summary>Thinking</summary>\n\n${part.text}\n\n</details>`;
    case 'image':
      return `*[Image: ${attachmentName(part.attachmentId) ?? part.attachmentId}]*`;
    case 'file':
      return `*[File: ${part.filename}]*`;
    case 'tool-call':
      return `**Tool call:** \`${part.name}\`\n\n${fenced(cut(asText(part.args)), 'json')}`;
    case 'tool-result':
      return `**${part.isError ? 'Tool error' : 'Tool result'}:** \`${part.name}\`\n\n${fenced(cut(asText(part.result)))}`;
    case 'notice':
      return `*${part.text}*`;
  }
}

function heading(m: CanonMessage): string {
  if (m.role === 'user') return 'You';
  if (m.role === 'system') return 'System';
  const by = m.producedBy;
  return by ? `${by.profileName} (${by.modelId})` : 'Assistant';
}

/**
 * The conversation as Markdown: a title, a line saying when and how much,
 * then each shown message under a heading naming who wrote it. A compare
 * reply says how many replies were compared; the others are only in the JSON.
 */
export function chatToMarkdown(chat: Chat, messages: CanonMessage[], attachments: Attachment[], exportedAt: Date): string {
  const path = shownPath(messages, chat.headMessageId);
  const names = new Map(attachments.map((a) => [a.id, a.filename]));
  const attachmentName = (id: string): string | null => names.get(id) ?? null;

  const out: string[] = [`# ${chat.title}`, '', `*Exported from Grunt on ${exportedAt.toISOString()}. ${path.length} message${path.length === 1 ? '' : 's'}.*`];
  for (const m of path) {
    out.push('', `## ${heading(m)}`, '');
    let siblings: CanonMessage[] = [m];
    try {
      siblings = siblingsOf(messages, m.id);
    } catch {
      // not in the set -- no siblings to mention
    }
    if (m.role === 'assistant' && isCompareSet(siblings)) {
      out.push(`*One of ${siblings.length} compared replies; the others are in the JSON export.*`, '');
    }
    const body = m.parts.map((p) => partToMarkdown(p, attachmentName)).filter((s) => s.length > 0);
    if (body.length > 0) out.push(body.join('\n\n'));
    if (m.status === 'error') out.push('', `*This reply failed${m.error?.message ? `: ${m.error.message}` : '.'}*`);
    if (m.status === 'cancelled') out.push('', '*Stopped before it finished.*');
    if (m.status === 'streaming') out.push('', '*Still being written when exported.*');
  }
  return `${out.join('\n')}\n`;
}

/** The whole chat as JSON: every message on every branch, its usage rows and what its attachments were. */
export function chatToJson(chat: Chat, messages: CanonMessage[], attachments: Attachment[], usage: UsageRecord[], exportedAt: Date): ChatExportJson {
  return {
    format: CHAT_EXPORT_FORMAT,
    version: CHAT_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    chat,
    shownPath: shownPath(messages, chat.headMessageId).map((m) => m.id),
    messages,
    usage,
    attachments: attachments.map(({ id, messageId, filename, mime, size }) => ({ id, messageId, filename, mime, size })),
  };
}

/**
 * A file name for the export: the chat title with the characters Windows and
 * other file systems refuse (and control characters) replaced, trimmed of
 * trailing dots and spaces, at most 80 characters, falling back to "chat".
 */
export function exportFilename(title: string, extension: 'md' | 'json'): string {
  const cleaned = title.replace(/\s+/g, ' ').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 80).replace(/[. ]+$/, '');
  return `${cleaned || 'chat'}.${extension}`;
}
