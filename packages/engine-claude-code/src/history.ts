import { isAskTool, isPlanTool } from '@otherbench/core/domain/thread-tools.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';

/**
 * Most recent characters of seeded history kept for a fresh session, about
 * 15K tokens. The seed stays in the session it starts, so it is read again
 * with every later turn there, not only once.
 */
export const HISTORY_CHAR_LIMIT = 60_000;

function pathOrCommand(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const a = args as Record<string, unknown>;
  const v = a['path'] ?? a['file_path'] ?? a['command'];
  return typeof v === 'string' ? ` ${v.length > 120 ? `${v.slice(0, 117)}...` : v}` : '';
}

interface ResultSeen {
  ok: boolean;
  text: string;
}

function resultText(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result) ?? '';
}

/** The question texts of an ask call, read leniently (it may be malformed). */
function askedQuestions(args: unknown): string {
  const list = typeof args === 'object' && args !== null ? (args as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(list)) return '?';
  return list.map((q) => (typeof q === 'object' && q !== null && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question : '?')).join(' / ');
}

function renderParts(parts: Part[], results: Map<string, ResultSeen>): string {
  const lines: string[] = [];
  for (const p of parts) {
    if (p.type === 'text') lines.push(p.text);
    else if (p.type === 'tool-call') {
      const seen = results.get(p.id);
      // Questions and plans keep what was decided (spec 2026-10-12-thread-cards-design §6).
      if (isAskTool(p.name)) lines.push(`[asked: ${askedQuestions(p.args)} -> ${(seen?.text ?? 'no answer').slice(0, 500)}]`);
      else if (isPlanTool(p.name)) lines.push(`[plan -> ${(seen?.text ?? 'no answer').split('\n')[0]}]`);
      else lines.push(`[tool ${p.name}${pathOrCommand(p.args)} -> ${seen?.ok === false ? 'error' : 'ok'}]`);
    } else if (p.type === 'image' || p.type === 'file') lines.push('[attachment]');
  }
  return lines.join('\n');
}

/** The newest of `blocks` that fit in HISTORY_CHAR_LIMIT, whole; the end of the newest alone when it doesn't fit by itself. */
function newestThatFit(blocks: string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const add = block.length + (kept.length > 0 ? 2 : 0);
    if (size + add > HISTORY_CHAR_LIMIT) {
      if (kept.length === 0) kept.push(block.slice(block.length - HISTORY_CHAR_LIMIT));
      break;
    }
    kept.unshift(block);
    size += add;
  }
  return kept.join('\n\n');
}

/**
 * OtherBench's history for a branch, as context for a fresh Claude Code session
 * (spec §2 rule 2): every message before the new user message, text verbatim,
 * tool calls as one-liners, reasoning and system prompts dropped. Keeps the
 * newest whole messages that fit in HISTORY_CHAR_LIMIT characters (the end of
 * the newest one alone, when even that is longer).
 */
export function renderHistory(history: CanonMessage[]): string {
  const prior = history.filter((m) => m.role !== 'system').slice(0, -1);
  if (prior.length === 0) return '';
  const blocks = prior.map((m) => {
    const results = new Map<string, ResultSeen>();
    for (const p of m.parts) if (p.type === 'tool-result') results.set(p.id, { ok: !p.isError, text: resultText(p.result) });
    const who = m.role === 'user' ? '[user]' : m.producedBy ? `[assistant: ${m.producedBy.profileName} · ${m.producedBy.modelId}]` : '[assistant]';
    // A user note inside a reply ends the assistant block where it falls: it is the user's, then the reply goes on.
    const out: string[] = [];
    let run: Part[] = [];
    const flush = () => {
      if (run.length > 0) out.push(`${who} ${renderParts(run, results)}`);
      run = [];
    };
    for (const p of m.parts) {
      if (p.type !== 'user-note') {
        run.push(p);
        continue;
      }
      flush();
      out.push(`[user] ${[p.text, ...p.attachments.map(() => '[attachment]')].filter((l) => l.length > 0).join('\n')}`);
    }
    if (run.length > 0 || out.length === 0) flush();
    return out.join('\n\n');
  });
  let body = blocks.join('\n\n');
  if (body.length > HISTORY_CHAR_LIMIT) body = `[earlier messages omitted]\n${newestThatFit(blocks)}`;
  return `<otherbench-history>\nThe conversation so far in OtherBench, before you joined it:\n\n${body}\n</otherbench-history>`;
}
