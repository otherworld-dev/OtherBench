import type { ConnectionKind } from '../types/config.js';

/**
 * The system-prompt block naming the tools a turn can use right now. A chat's
 * tools change when its profile's tool policy, its folders or its MCP servers
 * do, and a model that said earlier in the chat that it couldn't (say) write
 * files tends to keep believing its own words over the tool list. Sent with
 * every turn, so the latest list is the one the model reads.
 */
export function availableToolsPrompt(names: readonly string[]): string {
  return `# Your tools\nThe tools you can use right now: ${names.join(', ')}. This list is current: if an earlier message in this chat says one of these wasn't available, your tools have changed since, so use it.`;
}

/** Whether a turn's system prompt names its tools: not for Claude Code, which runs its own tools, not Grunt's. */
export function namesItsTools(kind: ConnectionKind): boolean {
  return kind !== 'claude_code';
}
