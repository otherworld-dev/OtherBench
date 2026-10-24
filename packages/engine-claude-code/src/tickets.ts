/**
 * Approval tickets (spec 2026-10-12-model-browser-design §4). In Claude Code
 * the PreToolUse hook approves a call and OtherBench's MCP server runs it later,
 * and a web page can move in between. For a relayed spec with `describeCall`,
 * the gate keeps the arguments the broker approved here, keyed by the tool
 * and Claude Code's raw input, and the server runs only those. Each ticket
 * runs once; a reply's tickets end with it. A ticket also keeps the hook's
 * tool-use id, so two identical calls made at once each run under their own
 * (their progress and their result go to the right call).
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
  private readonly all = new Map<number, { key: string; args: unknown; toolUseId?: string }>();
  /** The sequence numbers waiting under each key, oldest first. */
  private readonly waiting = new Map<string, number[]>();
  private next = 0;

  add(toolName: string, input: unknown, args: unknown, toolUseId?: string): void {
    const key = ticketKey(toolName, input);
    if (this.all.size >= MAX_TICKETS) this.dropOldest();
    const seq = this.next++;
    this.all.set(seq, { key, args, ...(toolUseId !== undefined ? { toolUseId } : {}) });
    const list = this.waiting.get(key) ?? [];
    list.push(seq);
    this.waiting.set(key, list);
  }

  /**
   * The ticket for this tool and input whose tool-use id is `toolUseId`, else
   * the oldest for them (the call didn't say which it is). A call that names an
   * id no ticket holds takes the oldest one whose hook gave no id before one
   * stamped with another call's.
   */
  take(toolName: string, input: unknown, toolUseId?: string): { args: unknown; toolUseId?: string } | null {
    const key = ticketKey(toolName, input);
    const list = this.waiting.get(key);
    if (!list || list.length === 0) return null;
    const find = (id: string | undefined): number => list.findIndex((seq) => this.all.get(seq)?.toolUseId === id);
    const named = toolUseId === undefined ? -1 : find(toolUseId);
    const unnamed = named < 0 && toolUseId !== undefined ? find(undefined) : -1;
    const [seq] = list.splice(named >= 0 ? named : unnamed >= 0 ? unnamed : 0, 1);
    if (list.length === 0) this.waiting.delete(key);
    const ticket = seq === undefined ? undefined : this.all.get(seq);
    if (seq !== undefined) this.all.delete(seq);
    return ticket ? { args: ticket.args, ...(ticket.toolUseId !== undefined ? { toolUseId: ticket.toolUseId } : {}) } : null;
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
