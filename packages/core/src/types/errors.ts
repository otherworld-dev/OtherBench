import type { ErrorKind, SerializedError } from './messages.js';

/**
 * Maps an arbitrary thrown value -- in practice, almost always an AI SDK
 * error (an `AISDKError` subclass from `@ai-sdk/provider`, or `RetryError`
 * from `ai`) or a raw network/runtime error -- onto OtherBench's own
 * `SerializedError` shape.
 *
 * `@otherbench/core` has no *runtime* dependency on the AI SDK packages (it stays
 * dependency-free by design -- see package.json, where `@ai-sdk/provider`
 * and `ai` are devDependencies used only by errors.test.ts to construct
 * realistic error instances to classify). So this file deliberately does NOT
 * `import` or `instanceof`-check those classes; instead it duck-types on the
 * `name` string every `AISDKError` subclass sets in its constructor (verified
 * against the installed `@ai-sdk/provider@3.0.15`: e.g. `APICallError` ->
 * `"AI_APICallError"`, `LoadAPIKeyError` -> `"AI_LoadAPIKeyError"`) plus a
 * handful of structural fields (`statusCode`, `isRetryable`, `lastError`).
 * This keeps the classifier correct against the real SDK's error shapes
 * (per task 14 decision #1) without coupling `@otherbench/core` to it.
 *
 * Invariant: only `rate_limit` and `transient` are ever retryable -- every
 * branch below derives `retryable` directly from the `kind` it assigns
 * (never from a provider's own `isRetryable` flag in isolation), so this
 * holds by construction rather than by convention.
 */
export function classifyProviderError(err: unknown): SerializedError {
  // AI SDK's own internal retry-with-backoff (`streamText`'s `maxRetries`)
  // wraps an exhausted retry loop in `RetryError`, whose useful information
  // is its `lastError` (the final underlying failure) -- classify that
  // instead of the wrapper so the caller gets a real kind, not `unknown`.
  if (hasName(err, 'AI_RetryError')) {
    const retryErr = err as RetryErrorLike;
    if (retryErr.lastError !== undefined) {
      const inner = classifyProviderError(retryErr.lastError);
      return { ...inner, message: retryErr.message ?? inner.message, detail: err };
    }
  }

  if (isAbortError(err)) {
    return { kind: 'cancelled', message: err.message || 'The request was cancelled.', retryable: false };
  }

  if (hasName(err, 'AI_APICallError')) {
    const apiErr = err as ApiCallErrorLike;
    const message = apiErr.message ?? 'The provider API call failed.';
    const haystack = `${message} ${apiErr.responseBody ?? ''}`;
    const { kind, retryable } = classifyApiCallError(apiErr.statusCode, haystack, apiErr.isRetryable ?? false);
    return { kind, message, retryable, detail: { statusCode: apiErr.statusCode } };
  }

  if (hasName(err, 'AI_LoadAPIKeyError') || hasName(err, 'AI_LoadSettingError')) {
    return { kind: 'auth', message: messageOf(err, 'Missing or invalid API key.'), retryable: false };
  }

  if (hasName(err, 'AI_NoSuchModelError')) {
    return { kind: 'model_not_found', message: messageOf(err, 'Model not found.'), retryable: false };
  }

  if (hasName(err, 'AI_UnsupportedFunctionalityError')) {
    return { kind: 'capability', message: messageOf(err, 'Requested functionality is not supported by this model.'), retryable: false };
  }

  // The provider returned successfully but with an empty/no-content body --
  // this is a known-flaky failure mode (observed in practice on more than
  // one provider under load) rather than a structural problem with the
  // request, so it is treated as transient/retryable.
  if (hasName(err, 'AI_EmptyResponseBodyError') || hasName(err, 'AI_NoContentGeneratedError')) {
    return { kind: 'transient', message: messageOf(err, 'The provider returned no content.'), retryable: true };
  }

  // Generic network failures (DNS, connection refused, timeout, TLS) throw a
  // plain Error/TypeError with no AI SDK name marker at all -- `fetch`
  // itself is the thrower, not a provider package.
  if (err instanceof Error) {
    const haystack = `${err.name} ${err.message} ${causeCodeOf(err)}`;
    if (NETWORK_FAILURE_PATTERN.test(haystack)) {
      return { kind: 'transient', message: err.message, retryable: true };
    }
    return { kind: 'unknown', message: err.message, retryable: false };
  }

  return { kind: 'unknown', message: messageOf(err, 'An unknown error occurred.'), retryable: false };
}

// ---------------------------------------------------------------------------

interface AiSdkErrorLike {
  name?: string;
  message?: string;
}

interface ApiCallErrorLike extends AiSdkErrorLike {
  statusCode?: number;
  isRetryable?: boolean;
  responseBody?: string;
}

interface RetryErrorLike extends AiSdkErrorLike {
  lastError?: unknown;
}

function hasName(err: unknown, name: string): err is AiSdkErrorLike {
  return typeof err === 'object' && err !== null && (err as AiSdkErrorLike).name === name;
}

function isAbortError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'AbortError';
}

function messageOf(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && typeof (err as AiSdkErrorLike).message === 'string') {
    return (err as AiSdkErrorLike).message as string;
  }
  return fallback;
}

function causeCodeOf(err: Error): string {
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return String((cause as { code: unknown }).code);
  }
  return '';
}

const NETWORK_FAILURE_PATTERN =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|fetch failed|network|socket hang up/i;
const CONTEXT_OVERFLOW_PATTERN =
  /context.?length|maximum context|context_length_exceeded|too (many|long)|exceeds? the (maximum|context)|prompt is too long/i;
const CONTENT_FILTER_PATTERN =
  /content.?filter|content policy|safety system|flagged|blocked by (the )?safety|moderation/i;
const MODEL_NOT_FOUND_PATTERN = /model[^.]*not found|no such model|unknown model|model.*does not exist/i;
const CAPABILITY_PATTERN = /does not support|not supported|unsupported functionality/i;

/**
 * Classifies an `APICallError` by HTTP status code first (the strongest
 * signal when present), falling back to message-pattern matching for
 * providers that reuse a generic 400 for context/content-filter/capability
 * failures rather than a distinct status code, and finally to the
 * provider's own `isRetryable` flag for anything left unmatched.
 */
function classifyApiCallError(
  statusCode: number | undefined,
  message: string,
  isRetryable: boolean
): { kind: ErrorKind; retryable: boolean } {
  if (statusCode === 401 || statusCode === 403) return { kind: 'auth', retryable: false };
  if (statusCode === 429) return { kind: 'rate_limit', retryable: true };
  if (CONTEXT_OVERFLOW_PATTERN.test(message)) return { kind: 'context_overflow', retryable: false };
  if (CONTENT_FILTER_PATTERN.test(message)) return { kind: 'content_filter', retryable: false };
  if (statusCode === 404 || MODEL_NOT_FOUND_PATTERN.test(message)) return { kind: 'model_not_found', retryable: false };
  if (CAPABILITY_PATTERN.test(message)) return { kind: 'capability', retryable: false };
  if ((statusCode !== undefined && statusCode >= 500) || isRetryable) return { kind: 'transient', retryable: true };
  return { kind: 'unknown', retryable: false };
}
