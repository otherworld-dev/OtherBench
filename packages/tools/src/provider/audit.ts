/**
 * The audit trail of `OtherBenchToolProvider` (`../provider.ts`): every call
 * on every path gets one row, whatever came of it and however it was
 * authorised, and this is what goes into it. Every row is written through
 * the provider's `writeAudit`, which is `writeAuditRow`; `auditCall` and
 * `recordAgentDenial` pass a call's arguments through `auditArgs` first.
 *
 * Redaction / summarisation for the audit trail (task 26 decision #5): the
 * audit row must record ENOUGH to reconstruct what happened, but never API
 * keys, file contents, or full command/tool output.
 */
import { revealAllHidden } from '@otherbench/core/domain/card-text.js';
import { isKeyCombination, isSensitiveKeyText } from '@otherbench/core/domain/computer-apps.js';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { ToolSource } from '@otherbench/core/types/config.js';
import { isSensitiveBrowserKey } from '../browser/tool.js';
import { isScreenTool } from './outcomes.js';

const SENSITIVE_KEY_PATTERN = /content|body|password|secret|token|apikey|api_key|authorization|output|oldstring|newstring/i;

const MAX_STRING_PREVIEW = 200;
const MAX_REDACT_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[omitted: too deeply nested]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_PREVIEW ? `${value.slice(0, MAX_STRING_PREVIEW)}… (${value.length} chars)` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The arguments as the audit keeps them, for EVERY audit row of every path
 * (`auditCall` and `recordAgentDenial` both come through here). For the
 * browser and for computer use:
 *
 *   - the text typed is redacted like file content: it may be something the
 *     user asked the model to type (spec 2026-10-12-model-browser-design §3,
 *     spec 2026-10-12-computer-use-design);
 *   - every other string is kept with nothing hidden in it (`visible`). The
 *     described arguments are clean already (a window's title is core's one
 *     clean line, a page element is `pageText`'s); the model's own arguments,
 *     which is what a refused call's row holds, can carry anything, a forged
 *     `appTitle` with a right-to-left override included.
 */
export function auditArgs(source: ToolSource, args: unknown): unknown {
  return isScreenTool(source) ? visible(withoutTypedText(args, source)) : args;
}

/**
 * `value` with every hidden, control or bidi character in any string of it
 * (keys included) spelled out as `<U+202E>`: the audit says what was there
 * instead of showing a line that reads differently from what it is.
 */
function visible(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return revealAllHidden(value);
  if (depth > MAX_REDACT_DEPTH || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => visible(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[revealAllHidden(key)] = visible(v, depth + 1);
  return out;
}

/**
 * `args` without the text a call would type. The browser's `text` is always
 * typed text; its `press` `key` follows the computer tool's rule below in the
 * browser's own key names (`isSensitiveBrowserKey`): kept when it types
 * nothing or is a shortcut, `[redacted: 1 key]` when it types a character.
 * The computer tool's `text` is typed text or one key
 * combination. A combination is kept only when it says what was pressed and
 * holds nothing typed (core's `isSensitiveKeyText`): one with ctrl or alt
 * (`ctrl+s`), or a key that types nothing (`return`, `shift+tab`, `f5`). A
 * bare or shift-only key that types a character (`a`, `shift+a`, `7`) is
 * `[redacted: 1 key]`: a password entered one `key` action at a time must not
 * be readable a character per row. Anything else under `text` (a `key` action
 * carrying a sentence, a click carrying text) is typed text: only its length
 * is kept.
 */
function withoutTypedText(args: unknown, source: 'browser' | 'computer'): unknown {
  if (typeof args !== 'object' || args === null) return args;
  const a = args as Record<string, unknown>;
  if (source === 'browser') {
    const out: Record<string, unknown> = { ...a };
    if ('text' in a) out['text'] = '[redacted]';
    if ('key' in a && isSensitiveBrowserKey(a['key'])) out['key'] = '[redacted: 1 key]';
    return out;
  }
  if (!('text' in a)) return args;
  const text = a['text'];
  if (a['action'] === 'key' && isKeyCombination(text)) return isSensitiveKeyText(text) ? { ...a, text: '[redacted: 1 key]' } : args;
  if (typeof text !== 'string') return { ...a, text: '[redacted]' };
  let characters = 0;
  for (const _ of text) characters += 1;
  return { ...a, text: `[redacted: ${characters} ${characters === 1 ? 'character' : 'characters'}]` };
}

/**
 * Claude Code's name for an OtherBench tool that types, relayed on its per-process
 * OtherBench server (`mcp__otherbench_<hex>__browser`, `mcp__otherbench_<hex>__computer`),
 * or the tool's own name. The group is which of the two it is.
 */
export const RELAYED_TYPING_TOOL_NAME = /^(?:mcp__otherbench_[0-9a-f]+__)?(browser|computer)$/;

export function summarizeResult(result: unknown): string {
  if (result && typeof result === 'object' && (result as { error?: unknown }).error === true) {
    const code = (result as { code?: unknown }).code;
    return `error${typeof code === 'string' ? `: ${code}` : ''}`;
  }
  if (typeof result === 'string') return `ok (${result.length} chars)`;
  if (Array.isArray(result)) return `ok (${result.length} item${result.length === 1 ? '' : 's'})`;
  if (result && typeof result === 'object') {
    const fieldCount = Object.keys(result).length;
    return `ok (${fieldCount} field${fieldCount === 1 ? '' : 's'})`;
  }
  return 'ok';
}

/**
 * Writes one audit row: the body of the provider's `writeAudit`. `args` must
 * already be what the audit may keep. A failure to write is logged, never
 * thrown at the call.
 */
export function writeAuditRow(
  store: Store,
  generateId: () => string,
  ctx: ToolContext,
  toolName: string,
  args: unknown,
  result: unknown,
  durationMs: number,
  grantedBy: string,
  summaryOverride?: string,
  decidedOnNode?: string
): void {
  try {
    store.audit.create({
      id: generateId(),
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      toolName,
      argsRedacted: redact(args),
      resultSummary: summaryOverride ?? summarizeResult(result),
      durationMs,
      grantedBy,
      ...(decidedOnNode ? { decidedOnNode } : {}),
    });
  } catch (err) {
    console.error(`[OtherBenchToolProvider] failed to write an audit row for "${toolName}":`, err);
  }
}
