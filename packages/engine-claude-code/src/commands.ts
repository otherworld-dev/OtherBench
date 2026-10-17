import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { CommandRow } from '@otherbench/core/domain/context-lines.js';

/**
 * The Claude Code built-ins a chat offers: the ones that work from a chat here.
 * The rest (/config, /security-review and so on) need Claude Code's own screen or
 * shell access, which a chat doesn't have. /review is named `code-review`, with
 * `review` as its alias.
 */
export const ALLOWED_BUILTINS: readonly string[] = ['init', 'code-review', 'context'];

/** Names OtherBench handles itself (OWN_COMMANDS), so Claude Code's versions are hidden. */
const OWNED = new Set(['clear', 'reset', 'new', 'compact']);

/** Claude Code's command list as a chat's slash menu shows it: own built-ins last, nothing OtherBench owns. */
export function chatCommands(rows: readonly SlashCommand[]): CommandRow[] {
  return rows
    .filter((r) => !(r.builtin === true && !ALLOWED_BUILTINS.includes(r.name)))
    .filter((r) => ![r.name, ...(r.aliases ?? [])].some((n) => OWNED.has(n)))
    .map((r): CommandRow & { builtin: boolean } => ({ name: r.name, description: r.description, argumentHint: r.argumentHint, aliases: r.aliases ?? [], builtin: r.builtin === true }))
    .sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.name.localeCompare(b.name))
    .map(({ builtin: _builtin, ...row }) => row);
}
