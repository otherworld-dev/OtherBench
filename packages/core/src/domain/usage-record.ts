import type { Store, UsagePurpose } from '../ports/store.js';
import type { ResolvedProfile } from '../types/config.js';
import { estimateCost, type PricingSnapshot, type Usage } from '../types/usage.js';

export interface UsageWrite {
  id: string;
  chatId: string;
  /** The reply the row hangs off: its own, a sub-agent's parent, or the one a background call was about. */
  messageId: string;
  profile: ResolvedProfile;
  usage: Usage;
  latencyMs: number;
  subagentCallId?: string;
  purpose?: UsagePurpose;
}

/**
 * Writes one usage row, priced with the model row as it is now (not the
 * possibly stale `ResolvedProfile.model` captured when the call began), so
 * editing a model's price later never changes what this call cost.
 */
export function recordUsage(store: Pick<Store, 'models' | 'usage'>, w: UsageWrite): void {
  const currentModel = w.profile.model ? store.models.get(w.profile.model.id) : null;
  const pricingSnapshot: PricingSnapshot = currentModel
    ? {
        priceInPer1m: currentModel.priceInPer1m,
        priceOutPer1m: currentModel.priceOutPer1m,
        priceCachedPer1m: currentModel.priceCachedPer1m,
        currency: currentModel.currency,
      }
    : { priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD' };

  store.usage.create({
    id: w.id,
    chatId: w.chatId,
    messageId: w.messageId,
    profileId: w.profile.id,
    connectionId: w.profile.connectionId,
    modelId: w.profile.modelId,
    tokensIn: w.usage.tokensIn,
    tokensOut: w.usage.tokensOut,
    tokensCached: w.usage.tokensCached,
    tokensCacheWrite: w.usage.tokensCacheWrite ?? 0,
    tokensReasoning: w.usage.tokensReasoning,
    costEstimate: estimateCost(w.usage, pricingSnapshot),
    pricingSnapshot,
    latencyMs: w.latencyMs,
    ...(w.subagentCallId ? { subagentCallId: w.subagentCallId } : {}),
    ...(w.purpose ? { purpose: w.purpose } : {}),
  });
}
