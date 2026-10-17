import type { CanonMessage, Part } from '../types/messages.js';

/** What Claude Code chats are told on `/compact` with nothing to compact. */
export const NOTHING_TO_COMPACT =
  "There's no Claude Code session here to compact. Send a message first, or use /clear to start fresh.";

/** Fed to models ahead of a compact summary. */
export const COMPACT_PREAMBLE = 'The conversation before this point was compacted. Its summary follows.';

export type ContextCommand = { kind: 'clear' } | { kind: 'compact'; focus: string };

export type CommandRow = { name: string; description: string; argumentHint: string; aliases: string[] };

/** OtherBench's own commands, shown beside the ones Claude Code reports. */
export const OWN_COMMANDS: readonly CommandRow[] = [
  { name: 'clear', description: 'Start fresh: Claude forgets everything above this line', argumentHint: '', aliases: ['reset', 'new'] },
  { name: 'compact', description: 'Swap the conversation so far for a summary', argumentHint: '[focus]', aliases: [] },
];

/** `/clear`, `/reset`, `/new`, `/compact [focus]`; anything else is plain text. */
export function parseContextCommand(text: string): ContextCommand | null {
  const t = text.trim();
  if (t === '/clear' || t === '/reset' || t === '/new') return { kind: 'clear' };
  const m = /^\/compact(?:\s+([\s\S]*))?$/.exec(t);
  if (m) return { kind: 'compact', focus: (m[1] ?? '').trim() };
  return null;
}

export function contextPart(cmd: ContextCommand): Part {
  return cmd.kind === 'compact'
    ? { type: 'context', kind: 'compact', ...(cmd.focus ? { focus: cmd.focus } : {}) }
    : { type: 'context', kind: 'clear' };
}

export function contextLineOf(m: CanonMessage): { kind: 'clear' | 'compact'; focus?: string } | null {
  if (m.role !== 'user') return null;
  for (const p of m.parts) {
    if (p.type === 'context') return p.focus !== undefined ? { kind: p.kind, focus: p.focus } : { kind: p.kind };
  }
  return null;
}

/**
 * What a model is fed: `path` (root -> the message being answered) from the
 * latest context line down. The last element is the message being answered
 * and is never itself a line. A compact line counts only when its reply
 * completed with a summary; otherwise it is skipped.
 */
export function cutAtContextLine(path: CanonMessage[]): CanonMessage[] {
  for (let i = path.length - 2; i >= 0; i--) {
    const m = path[i]!;
    const line = contextLineOf(m);
    if (!line) continue;
    if (line.kind === 'clear') return path.slice(i + 1);
    const reply = path[i + 1];
    if (!reply || reply.role !== 'assistant' || reply.status !== 'complete') continue;
    const summary = reply.parts.find((p) => p.type === 'context-summary');
    if (!summary || summary.type !== 'context-summary') continue;
    return [
      { ...m, parts: [{ type: 'text', text: COMPACT_PREAMBLE }] },
      { ...reply, parts: [{ type: 'text', text: summary.text }] },
      ...path.slice(i + 2),
    ];
  }
  return path;
}
