import type { PricingSnapshot } from '../../types/usage.js';

// --- usage ----------------------------------------------------------------

export type UsagePurpose = 'title' | 'memory';

export interface UsageRecord {
  id: string;
  chatId: string;
  messageId: string;
  profileId: string;
  connectionId: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Input tokens written to the provider's prompt cache (`Usage.tokensCacheWrite`). */
  tokensCacheWrite?: number;
  tokensReasoning: number;
  costEstimate: number | null;
  pricingSnapshot: PricingSnapshot;
  latencyMs: number;
  /**
   * Set on the row of a call OtherBench made by itself about a reply: naming
   * the chat after it (`title`), or folding it into project or global memory
   * (`memory`). The row hangs off that reply (`messageId`) but carries the
   * profile that made the call. Absent on a reply's own row.
   */
  purpose?: UsagePurpose;
  /**
   * Set on a sub-agent's own usage row (spec 2026-10-12-api-subagents-design):
   * the parent's `subagent` tool call id. The row hangs off the parent reply
   * (`messageId`) but carries the sub-agent's profile, connection and model.
   */
  subagentCallId?: string;
}

export interface UsageRepo {
  create(u: UsageRecord): UsageRecord;
  get(id: string): UsageRecord | null;
  list(chatId: string): UsageRecord[];
  update(id: string, patch: Partial<Omit<UsageRecord, 'id'>>): UsageRecord;
  delete(id: string): void;
}
