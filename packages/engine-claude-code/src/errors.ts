import type { SerializedError } from '@otherbench/core/types/messages.js';
import { CLAUDE_BACKEND } from './env.js';

const tail = (text: string): string => (text.length > 600 ? `...${text.slice(-600)}` : text);

export function isMissingSessionError(text: string): boolean {
  return /no conversation found|session .*not found|could not find session/i.test(text);
}

export const AUTO_MODE_UNAVAILABLE_MESSAGE = "Auto mode isn't available for this account or model. Turn it off to continue.";

/** The turn error when a chat asks for auto mode and Claude Code can't run in it. */
export function autoModeUnavailable(): SerializedError {
  return { kind: 'capability', retryable: false, message: AUTO_MODE_UNAVAILABLE_MESSAGE };
}

export function classifyClaudeCodeFailure(text: string, ctx: { backend: string; modelId: string; rateLimitResetsAt?: number | null; autoMode?: boolean }): SerializedError {
  if (/not logged in|\/login|invalid api key|authentication|unauthori[sz]ed|\b401\b/i.test(text)) {
    // `/login` only fixes the Claude login; an endpoint backend uses the connection's token.
    const message = ctx.backend === CLAUDE_BACKEND ? "Claude Code isn't logged in. Run `claude` and `/login`." : `${ctx.backend} rejected the token.`;
    return { kind: 'auth', retryable: false, message };
  }
  // Only an auto-mode turn can fail this way (detection is normally via the
  // init permissionMode); other turns must not be misread.
  if (ctx.autoMode === true && /auto[ -]?mode/i.test(text) && /unavailable|not available|not supported|not enabled|disabled/i.test(text)) {
    return autoModeUnavailable();
  }
  if (ctx.rateLimitResetsAt != null || /usage limit|rate.?limit|\b429\b|overloaded/i.test(text)) {
    const resets = ctx.rateLimitResetsAt ?? Number(/\|(\d{9,})/.exec(text)?.[1] ?? NaN);
    const when = Number.isFinite(resets) ? ` It resets at ${new Date(resets * 1000).toLocaleString()}.` : '';
    return { kind: 'rate_limit', retryable: true, message: `Claude usage limit reached.${when}`, detail: { text: tail(text) } };
  }
  if (ctx.backend !== CLAUDE_BACKEND && /ECONNREFUSED|ENOTFOUND|fetch failed|connect(ion)? (refused|error)|socket hang up/i.test(text)) {
    return { kind: 'transient', retryable: true, message: `Can't reach ${ctx.backend}.` };
  }
  if (/does not support tools|tool use is not supported|tools are not supported/i.test(text)) {
    return { kind: 'capability', retryable: false, message: `${ctx.modelId} can't use tools, which Claude Code needs. Pick a tool-capable model.` };
  }
  if (/model .*not found|not_found_error|unknown model|\b404\b/i.test(text)) {
    return { kind: 'model_not_found', retryable: false, message: `Model not found: ${ctx.modelId}.` };
  }
  return { kind: 'unknown', retryable: false, message: tail(text) || 'Claude Code failed without an error message.' };
}
