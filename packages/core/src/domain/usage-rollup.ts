import type { UsageRecord } from '../ports/store.js';
import type { CanonMessage } from '../types/messages.js';

export interface ProfileRollup {
  profileId: string;
  profileName: string;
  modelId: string;
  currency: string;
  measuredCost: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  /** Usage rows tied to a 'complete' message (or an 'error' message that still raced a `finish` event -- see this module's doc). */
  completeCount: number;
  /** Usage rows tied to a 'cancelled' message -- always zero tokens/cost (turn.ts's ZERO_USAGE), deliberately excluded from measuredCost so a cancelled paid stream never reads as "free". */
  cancelledCount: number;
  /** Assistant messages with status 'error' and NO usage row at all -- the engine never reported a `finish`, so there is genuinely nothing to sum, but the call must not vanish from the report. */
  unmeasuredErrorCount: number;
  /** Sub-agents that ran as this profile and finished (spec 2026-10-12-api-subagents-design). Their tokens and cost are in the totals above. */
  subagentCount: number;
}

export interface ChatRollup {
  chatId: string;
  chatTitle: string;
  measuredCost: number;
  cancelledCount: number;
  unmeasuredErrorCount: number;
}

export interface DateBucket {
  /** UTC calendar date the bucket's cost was incurred on, YYYY-MM-DD, derived from the producing message's `createdAt`. */
  date: string;
  cost: number;
}

export interface UsageRollup {
  profiles: ProfileRollup[];
  chats: ChatRollup[];
  /** Date-ascending; only measured (never cancelled/unmeasured) cost lands here. */
  buckets: DateBucket[];
  totalMeasuredCost: number;
  totalCancelledCount: number;
  totalUnmeasuredErrorCount: number;
}

function dateKey(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

/**
 * Builds a spend rollup from raw `usage` rows plus the assistant messages
 * they (may) belong to, sliced by profile, by chat, and by day. Pure and
 * DB-agnostic -- the caller (routes/usage.ts) is responsible for gathering
 * `usageRows`/`assistantMessages` for whatever scope it wants (one chat, or
 * every chat), and for resolving `chatTitles` if it wants readable chat
 * names rather than raw ids.
 *
 * This function is where task 28's two usage-honesty requirements are
 * actually enforced, not just documented:
 *
 * 1. A cancelled variant's usage row is real (TurnRunner always writes one
 *    for a cancellation, see turn.ts's `ZERO_USAGE`) but its tokens/cost are
 *    always zero -- not an estimate of what was actually consumed, just the
 *    honest admission that the engine reported nothing partial. Summing
 *    those zeros into `measuredCost` wouldn't be numerically wrong (adding
 *    zero changes nothing) but would make a cancelled paid call
 *    indistinguishable from a genuinely free one in the UI. So a cancelled
 *    row's cost/tokens are excluded from `measuredCost`/token totals/date
 *    buckets entirely, and it is counted in `cancelledCount` instead -- a
 *    separate, explicit "N cancelled (unmeasured)" figure the caller can
 *    surface however it likes, but can't accidentally fold into spend.
 *
 * 2. An errored variant that never received a `finish` event writes NO
 *    usage row at all (nothing to write -- see turn.ts), so it is invisible
 *    to a query that only reads the `usage` table. This function is handed
 *    the assistant messages too, specifically so it can find those:
 *    any 'error' message with no matching usage row becomes
 *    `unmeasuredErrorCount`, so an erroring, possibly-billed API call can
 *    never just vanish from a spend report. (An 'error' message that DID
 *    race a `finish` -- rare, but the store layer allows it -- has a real
 *    usage row and is counted as measured like any complete call; only the
 *    finish-less case is "unmeasured".)
 */
export function buildUsageRollup(
  usageRows: UsageRecord[],
  assistantMessages: CanonMessage[],
  chatTitles: Record<string, string> = {}
): UsageRollup {
  const messagesById = new Map(assistantMessages.map((m) => [m.id, m]));
  const measuredMessageIds = new Set<string>();

  const profiles = new Map<string, ProfileRollup>();
  const chats = new Map<string, ChatRollup>();
  const bucketCosts = new Map<string, number>();
  let totalMeasuredCost = 0;
  let totalCancelledCount = 0;
  let totalUnmeasuredErrorCount = 0;

  function profileRollup(id: string, name: string, modelId: string, currency: string): ProfileRollup {
    let entry = profiles.get(id);
    if (!entry) {
      entry = { profileId: id, profileName: name, modelId, currency, measuredCost: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0, completeCount: 0, cancelledCount: 0, unmeasuredErrorCount: 0, subagentCount: 0 };
      profiles.set(id, entry);
    }
    return entry;
  }

  function chatRollup(chatId: string): ChatRollup {
    let entry = chats.get(chatId);
    if (!entry) {
      entry = { chatId, chatTitle: chatTitles[chatId] ?? chatId, measuredCost: 0, cancelledCount: 0, unmeasuredErrorCount: 0 };
      chats.set(chatId, entry);
    }
    return entry;
  }

  /** Adds one usage row's tokens and cost to its profile, its chat, the grand total and the message's day. */
  function addMeasured(pr: ProfileRollup, cr: ChatRollup, row: UsageRecord, message: CanonMessage): void {
    const cost = row.costEstimate ?? 0;
    pr.measuredCost += cost;
    pr.tokensIn += row.tokensIn;
    pr.tokensOut += row.tokensOut;
    pr.tokensCached += row.tokensCached;
    pr.tokensReasoning += row.tokensReasoning;
    cr.measuredCost += cost;
    totalMeasuredCost += cost;
    const key = dateKey(message.createdAt);
    bucketCosts.set(key, (bucketCosts.get(key) ?? 0) + cost);
  }

  for (const row of usageRows) {
    const message = messagesById.get(row.messageId);
    if (!message) continue; // out of the caller's declared scope -- nothing to attribute this to.

    // A sub-agent's own row: its profile and model, always measured (it
    // really finished, whatever became of the reply), and it never marks
    // the reply as measured, so a failed reply with no row of its own still
    // shows as an unmeasured error.
    if (row.subagentCallId) {
      const card = message.parts.find((p): p is Extract<CanonMessage['parts'][number], { type: 'subagent' }> => p.type === 'subagent' && p.callId === row.subagentCallId);
      // Its card is gone after a retry clears the parts; then the reply's own
      // profile name still fits when it ran as the reply's profile.
      const fallbackName = message.producedBy?.profileId === row.profileId ? message.producedBy.profileName : 'Unknown profile';
      const pr = profileRollup(row.profileId, card?.profileName ?? fallbackName, card?.modelId ?? row.modelId, row.pricingSnapshot.currency);
      const cr = chatRollup(message.chatId);
      addMeasured(pr, cr, row, message);
      pr.subagentCount += 1;
      continue;
    }
    measuredMessageIds.add(message.id);

    const profileId = message.producedBy?.profileId ?? row.profileId;
    const profileName = message.producedBy?.profileName ?? 'Unknown profile';
    const modelId = message.producedBy?.modelId ?? row.modelId;
    const pr = profileRollup(profileId, profileName, modelId, row.pricingSnapshot.currency);
    const cr = chatRollup(message.chatId);

    if (message.status === 'cancelled') {
      pr.cancelledCount += 1;
      cr.cancelledCount += 1;
      totalCancelledCount += 1;
      continue; // honesty rule #1 -- see this function's doc.
    }

    // 'complete', or the rare 'error' that still raced a `finish` -- both
    // carry a real, engine-reported usage row.
    addMeasured(pr, cr, row, message);
    pr.completeCount += 1;
  }

  for (const message of assistantMessages) {
    if (message.status !== 'error' || measuredMessageIds.has(message.id)) continue; // honesty rule #2 only applies to a finish-less error.
    const profileId = message.producedBy?.profileId ?? 'unknown';
    const profileName = message.producedBy?.profileName ?? 'Unknown profile';
    const modelId = message.producedBy?.modelId ?? 'unknown';
    const pr = profileRollup(profileId, profileName, modelId, 'USD');
    pr.unmeasuredErrorCount += 1;
    const cr = chatRollup(message.chatId);
    cr.unmeasuredErrorCount += 1;
    totalUnmeasuredErrorCount += 1;
  }

  const buckets = [...bucketCosts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, cost]) => ({ date, cost }));

  return {
    profiles: [...profiles.values()].sort((a, b) => b.measuredCost - a.measuredCost),
    chats: [...chats.values()].sort((a, b) => b.measuredCost - a.measuredCost),
    buckets,
    totalMeasuredCost,
    totalCancelledCount,
    totalUnmeasuredErrorCount,
  };
}
