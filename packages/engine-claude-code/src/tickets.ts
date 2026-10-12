/**
 * Approval tickets (spec 2026-10-12-model-browser-design §4). In Claude Code
 * the PreToolUse hook approves a call and Grunt's MCP server runs it later,
 * and a web page can move in between. For a relayed spec with `describeCall`,
 * the gate keeps the arguments the broker approved here, keyed by the tool
 * and Claude Code's raw input, and the server runs only those. Each ticket
 * runs once; a reply's tickets end with it.
 */
export function ticketKey(toolName: string, input: unknown): string {
  return `${toolName}\u0000${JSON.stringify(input ?? {})}`;
}

export class ApprovalTickets {
  private readonly waiting = new Map<string, unknown[]>();

  add(toolName: string, input: unknown, args: unknown): void {
    const key = ticketKey(toolName, input);
    const list = this.waiting.get(key) ?? [];
    list.push(args);
    this.waiting.set(key, list);
  }

  take(toolName: string, input: unknown): { args: unknown } | null {
    const key = ticketKey(toolName, input);
    const list = this.waiting.get(key);
    if (!list || list.length === 0) return null;
    const args = list.shift();
    if (list.length === 0) this.waiting.delete(key);
    return { args };
  }

  clear(): void {
    this.waiting.clear();
  }

  get size(): number {
    let n = 0;
    for (const list of this.waiting.values()) n += list.length;
    return n;
  }
}
