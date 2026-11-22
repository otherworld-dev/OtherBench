import type { SerializedError } from '@otherbench/core/types/messages.js';
import { isClaudeLogin } from '@otherbench/core/types/claude-accounts.js';
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

/** Claude Code's own words for an account out of usage (not an overload or an API 429). */
const USAGE_LIMIT_TEXT = /usage limit|you['’]?ve hit your (usage )?limit/i;

/**
 * Claude Code's own words for a login that doesn't work. Deliberately not the
 * bare words `authentication`, `/login` or `401`: an MCP server that needs
 * signing in, a URL, or "took 401 ms" all carry those.
 */
const AUTH_TEXT = /not logged in|please run \/login|invalid api key|authentication_(error|failed)|oauth token (has )?(expired|been revoked|revoked)|unauthori[sz]ed/i;

/**
 * The lines of the process's stderr that are Claude Code's own report of the
 * failure: its login prompt, its `API Error: <status>` line, its usage-limit
 * line. Nothing else on stderr is read for meaning, because stderr also
 * carries whatever the MCP servers print, and their sign-in trouble, 404s and
 * refused connections were being reported as Claude Code's.
 */
const OWN_STDERR_LINE = /please run \/login|\bAPI Error: \d{3}\b|usage limit reached|you['’]?ve hit your (usage )?limit/i;

export interface ClaudeCodeFailureContext {
  backend: string;
  modelId: string;
  rateLimitResetsAt?: number | null;
  rateLimited?: boolean;
  autoMode?: boolean;
  /** The HTTP status the SDK gave for the failed API call (a result's `api_error_status`). */
  apiStatus?: number | null | undefined;
  /** The SDK's own error type for it (`SDKAssistantMessageError`: `authentication_failed`, `overloaded`, ...). */
  apiError?: string | null | undefined;
  /** The process's stderr, when the failure is the process ending: see `OWN_STDERR_LINE`. */
  stderr?: readonly string[];
}

/**
 * What a failed Claude Code turn is, for the user. What the SDK says in a
 * field decides first: the API call's HTTP status (given, or read from Claude
 * Code's own `API Error: <status>` line) and its error type. Wording is only
 * read when there is no status, so a 500 that mentions logging in is a server
 * error and a 503 "overloaded" is not a limit.
 *
 * `ctx.rateLimited`: the turn reported a usage limit (a rejected rate-limit
 * event, or Claude Code's own limit message), whether or not it said when it
 * resets. A `rate_limit` error carries `detail.usageLimit: true` only on such
 * evidence (that, a known reset time, or the limit text): an overload or a
 * bare 429 is a `rate_limit` too (the reply can still be continued on another
 * account), but must not hold the account, and its message says what it was.
 */
export function classifyClaudeCodeFailure(text: string, ctx: ClaudeCodeFailureContext): SerializedError {
  const stderr = (ctx.stderr ?? []).flatMap((chunk) => chunk.split(/\r?\n/)).filter((line) => line.trim() !== '');
  // The failure's own words, plus Claude Code's own lines from stderr.
  const words = [text, ...stderr.filter((line) => OWN_STDERR_LINE.test(line))].join('\n');
  const statusText = /\bAPI Error: (\d{3})\b/.exec(words)?.[1];
  const status = ctx.apiStatus ?? (statusText !== undefined ? Number(statusText) : null);
  /** A wording check, used only when no status says what happened. */
  const says = (pattern: RegExp): boolean => status === null && pattern.test(words);
  const who = isClaudeLogin(ctx.backend) ? 'Claude' : ctx.backend;

  if (status === 401 || ctx.apiError === 'authentication_failed' || says(AUTH_TEXT)) {
    // `/login` fixes main's login; another account is signed in from Settings; an endpoint backend uses the connection's token.
    const message =
      ctx.backend === CLAUDE_BACKEND
        ? "Claude Code isn't logged in. Run `claude` and `/login`."
        : isClaudeLogin(ctx.backend)
          ? "This Claude account isn't signed in. Sign in under Settings → Claude accounts."
          : `${ctx.backend} rejected the token.`;
    return { kind: 'auth', retryable: false, message };
  }
  // Only an auto-mode turn can fail this way (detection is normally via the
  // init permissionMode); other turns must not be misread.
  if (ctx.autoMode === true && /auto[ -]?mode/i.test(text) && /unavailable|not available|not supported|not enabled|disabled/i.test(text)) {
    return autoModeUnavailable();
  }
  const usageLimit = ctx.rateLimited === true || ctx.rateLimitResetsAt != null || ((status === null || status === 429) && USAGE_LIMIT_TEXT.test(words));
  const overloaded = status === 529 || ctx.apiError === 'overloaded' || says(/overloaded/i);
  if (usageLimit || overloaded || status === 429 || says(/rate.?limit|\b429\b/i)) {
    const resets = ctx.rateLimitResetsAt ?? Number(/\|(\d{9,})/.exec(words)?.[1] ?? NaN);
    const known = Number.isFinite(resets);
    const when = known ? ` It resets at ${new Date(resets * 1000).toLocaleString()}.` : '';
    // `resetsAt` in ms, for the account switcher to hold the account until; absent when the reset time isn't known.
    const detail = { text: tail(words), ...(known ? { resetsAt: resets * 1000 } : {}), ...(usageLimit ? { usageLimit: true } : {}) };
    const message = usageLimit
      ? `Claude usage limit reached.${when}`
      : `${who} is ${overloaded ? 'overloaded' : 'rate limited'} right now. Try again in a moment.`;
    return { kind: 'rate_limit', retryable: true, message, detail };
  }
  if ((status !== null && status >= 500) || ctx.apiError === 'server_error') {
    return { kind: 'transient', retryable: true, message: `${who} had a server error${status !== null ? ` (${status})` : ''}. Try again in a moment.` };
  }
  if (!isClaudeLogin(ctx.backend) && says(/ECONNREFUSED|ENOTFOUND|fetch failed|connect(ion)? (refused|error)|socket hang up/i)) {
    return { kind: 'transient', retryable: true, message: `Can't reach ${ctx.backend}.` };
  }
  if (/does not support tools|tool use is not supported|tools are not supported/i.test(words)) {
    return { kind: 'capability', retryable: false, message: `${ctx.modelId} can't use tools, which Claude Code needs. Pick a tool-capable model.` };
  }
  if (status === 404 || ctx.apiError === 'model_not_found' || says(/model .*not found|not_found_error|unknown model|\b404\b/i)) {
    return { kind: 'model_not_found', retryable: false, message: `Model not found: ${ctx.modelId}.` };
  }
  // Everything that was said, stderr included, so the reason can be read.
  return { kind: 'unknown', retryable: false, message: tail([text, ...stderr].join('\n')) || 'Claude Code failed without an error message.' };
}
