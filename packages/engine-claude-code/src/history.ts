import { isAskTool, isPlanTool } from '@grunt/core/domain/thread-tools.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';

/** Most recent characters of seeded history kept for a fresh session. */
export const HISTORY_CHAR_LIMIT = 200_000;

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

/**
 * Grunt's history for a branch, as context for a fresh Claude Code session
 * (spec §2 rule 2): every message before the new user message, text verbatim,
 * tool calls as one-liners, reasoning and system prompts dropped. Keeps the
 * most recent HISTORY_CHAR_LIMIT characters.
 */
export function renderHistory(history: CanonMessage[]): string {
  const prior = history.filter((m) => m.role !== 'system').slice(0, -1);
  if (prior.length === 0) return '';
  const blocks = prior.map((m) => {
    const results = new Map<string, ResultSeen>();
    for (const p of m.parts) if (p.type === 'tool-result') results.set(p.id, { ok: !p.isError, text: resultText(p.result) });
    const who = m.role === 'user' ? '[user]' : m.producedBy ? `[assistant: ${m.producedBy.profileName} · ${m.producedBy.modelId}]` : '[assistant]';
    return `${who} ${renderParts(m.parts, results)}`;
  });
  let body = blocks.join('\n\n');
  if (body.length > HISTORY_CHAR_LIMIT) body = `[earlier messages omitted]\n${body.slice(body.length - HISTORY_CHAR_LIMIT)}`;
  return `<grunt-history>\nThe conversation so far in Grunt, before you joined it:\n\n${body}\n</grunt-history>`;
}
