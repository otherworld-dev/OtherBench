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

/**
 * The most tickets one reply holds. A call Claude Code approved but never
 * ran leaves its ticket until the reply ends; past this many, the oldest is
 * dropped, and its call, should it still arrive, finds no approval and runs
 * nothing (`runRelayed`).
 */
export const MAX_TICKETS = 256;

export class ApprovalTickets {
  /** Every ticket, oldest first, by its sequence number. */
  private readonly all = new Map<number, { key: string; args: unknown }>();
  /** The sequence numbers waiting under each key, oldest first. */
  private readonly waiting = new Map<string, number[]>();
  private next = 0;

  add(toolName: string, input: unknown, args: unknown): void {
    const key = ticketKey(toolName, input);
    if (this.all.size >= MAX_TICKETS) this.dropOldest();
    const seq = this.next++;
    this.all.set(seq, { key, args });
    const list = this.waiting.get(key) ?? [];
    list.push(seq);
    this.waiting.set(key, list);
  }

  take(toolName: string, input: unknown): { args: unknown } | null {
    const key = ticketKey(toolName, input);
    const list = this.waiting.get(key);
    const seq = list?.shift();
    if (!list || seq === undefined) return null;
    if (list.length === 0) this.waiting.delete(key);
    const ticket = this.all.get(seq);
    this.all.delete(seq);
    return ticket ? { args: ticket.args } : null;
  }

  clear(): void {
    this.all.clear();
    this.waiting.clear();
  }

  get size(): number {
    return this.all.size;
  }

  /** The oldest ticket of all goes; it is also the oldest under its own key. */
  private dropOldest(): void {
    const oldest = this.all.entries().next();
    if (oldest.done) return;
    const [seq, { key }] = oldest.value;
    this.all.delete(seq);
    const list = this.waiting.get(key);
    if (list?.[0] === seq) list.shift();
    if (list?.length === 0) this.waiting.delete(key);
  }
}
