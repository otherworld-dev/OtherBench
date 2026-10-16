/**
 * The helpers Claude Code's agent started in one reply (its Task or Agent
 * tool), and which helper each tool call belongs to. The event mapper fills
 * it in as the helpers start and make calls; the approval gate reads it, so a
 * helper's approval card can say which helper is asking.
 */
export class HelperRegistry {
  private readonly helpers = new Map<string, string>();
  private readonly owners = new Map<string, string>();

  /** A helper started by the tool call `callId`, labelled `label`. */
  start(callId: string, label: string): void {
    this.helpers.set(callId, label);
  }

  isHelper(callId: string): boolean {
    return this.helpers.has(callId);
  }

  /** The tool call `toolUseId` was made by the helper started by `callId`. */
  own(toolUseId: string, callId: string): void {
    this.owners.set(toolUseId, callId);
  }

  /** The helper that made `toolUseId`, or null when it was the reply's own agent (or isn't known yet). */
  ownerOf(toolUseId: string | undefined): { callId: string; label: string } | null {
    const callId = toolUseId === undefined ? undefined : this.owners.get(toolUseId);
    const label = callId === undefined ? undefined : this.helpers.get(callId);
    return callId !== undefined && label !== undefined ? { callId, label } : null;
  }
}
