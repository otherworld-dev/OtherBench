import { describe, it, expect } from 'vitest';
import {
  APICallError,
  EmptyResponseBodyError,
  LoadAPIKeyError,
  NoContentGeneratedError,
  NoSuchModelError,
  UnsupportedFunctionalityError,
} from '@ai-sdk/provider';
import { RetryError } from 'ai';
import { classifyProviderError } from '../src/types/errors.js';

/**
 * These tests exercise `classifyProviderError` against *real* instances of
 * the error classes the installed AI SDK (`@ai-sdk/provider` 3.0.15, `ai`
 * 6.0.253) actually throws -- not invented shapes -- per task 14's decision
 * #1. `@otherbench/core` still has zero *runtime* dependency on either package
 * (see errors.ts: classification is done by duck-typing `err.name`/
 * structural fields, not `instanceof`/`isInstance`); both are devDependencies
 * here purely so this test file can construct authentic error instances.
 */

function apiError(overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) {
  return new APICallError({
    message: 'API call failed',
    url: 'https://api.example.com/v1/messages',
    requestBodyValues: {},
    isRetryable: false,
    ...overrides,
  });
}

describe('classifyProviderError', () => {
  it('maps a 429 APICallError to rate_limit, retryable', () => {
    const result = classifyProviderError(apiError({ statusCode: 429, isRetryable: true, message: 'Rate limited' }));
    expect(result).toMatchObject({ kind: 'rate_limit', retryable: true });
  });

  it('maps a 401 APICallError to auth, not retryable', () => {
    const result = classifyProviderError(apiError({ statusCode: 401, message: 'Invalid API key provided' }));
    expect(result).toMatchObject({ kind: 'auth', retryable: false });
  });

  it('maps a 403 APICallError to auth', () => {
    const result = classifyProviderError(apiError({ statusCode: 403, message: 'Forbidden' }));
    expect(result).toMatchObject({ kind: 'auth', retryable: false });
  });

  it('maps a context-length 400 to context_overflow', () => {
    const result = classifyProviderError(
      apiError({ statusCode: 400, message: "This model's maximum context length is 128000 tokens" })
    );
    expect(result).toMatchObject({ kind: 'context_overflow', retryable: false });
  });

  it('maps a content-filter 400 to content_filter', () => {
    const result = classifyProviderError(
      apiError({ statusCode: 400, message: 'Output blocked by our content filtering policy' })
    );
    expect(result).toMatchObject({ kind: 'content_filter', retryable: false });
  });

  it('maps a 404 to model_not_found', () => {
    const result = classifyProviderError(apiError({ statusCode: 404, message: 'The model `gpt-9` does not exist' }));
    expect(result).toMatchObject({ kind: 'model_not_found', retryable: false });
  });

  it('maps a "not supported" 400 to capability', () => {
    const result = classifyProviderError(
      apiError({ statusCode: 400, message: 'Image inputs are not supported by this model' })
    );
    expect(result).toMatchObject({ kind: 'capability', retryable: false });
  });

  it('maps a 500 to transient, retryable', () => {
    const result = classifyProviderError(apiError({ statusCode: 500, message: 'Internal server error', isRetryable: true }));
    expect(result).toMatchObject({ kind: 'transient', retryable: true });
  });

  it('maps an APICallError with no status code but isRetryable to transient', () => {
    const result = classifyProviderError(apiError({ statusCode: undefined, isRetryable: true, message: 'Connection reset' }));
    expect(result).toMatchObject({ kind: 'transient', retryable: true });
  });

  it('maps an unrecognised 400 with isRetryable false to unknown, not retryable', () => {
    const result = classifyProviderError(apiError({ statusCode: 400, isRetryable: false, message: 'Bad request' }));
    expect(result).toMatchObject({ kind: 'unknown', retryable: false });
  });

  it('maps LoadAPIKeyError to auth', () => {
    const result = classifyProviderError(new LoadAPIKeyError({ message: 'OpenAI API key is missing' }));
    expect(result).toMatchObject({ kind: 'auth', retryable: false });
  });

  it('maps NoSuchModelError to model_not_found', () => {
    const result = classifyProviderError(new NoSuchModelError({ modelId: 'gpt-9', modelType: 'languageModel' }));
    expect(result).toMatchObject({ kind: 'model_not_found', retryable: false });
  });

  it('maps UnsupportedFunctionalityError to capability', () => {
    const result = classifyProviderError(new UnsupportedFunctionalityError({ functionality: 'image input' }));
    expect(result).toMatchObject({ kind: 'capability', retryable: false });
  });

  it('maps EmptyResponseBodyError to transient, retryable', () => {
    const result = classifyProviderError(new EmptyResponseBodyError({}));
    expect(result).toMatchObject({ kind: 'transient', retryable: true });
  });

  it('maps NoContentGeneratedError to transient, retryable', () => {
    const result = classifyProviderError(new NoContentGeneratedError({}));
    expect(result).toMatchObject({ kind: 'transient', retryable: true });
  });

  it('unwraps a RetryError to classify its underlying lastError', () => {
    const cause = apiError({ statusCode: 429, isRetryable: true, message: 'Rate limited' });
    const retry = new RetryError({ message: 'Failed after 3 attempts.', reason: 'maxRetriesExceeded', errors: [cause, cause, cause] });
    const result = classifyProviderError(retry);
    expect(result).toMatchObject({ kind: 'rate_limit', retryable: true });
  });

  it('maps a DOMException AbortError to cancelled', () => {
    const result = classifyProviderError(new DOMException('This operation was aborted', 'AbortError'));
    expect(result).toMatchObject({ kind: 'cancelled', retryable: false });
  });

  it('maps a plain Error named AbortError to cancelled', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    const result = classifyProviderError(err);
    expect(result).toMatchObject({ kind: 'cancelled', retryable: false });
  });

  it('maps a connection-refused network error to transient, retryable', () => {
    const err = new TypeError('fetch failed');
    (err as unknown as { cause: unknown }).cause = { code: 'ECONNREFUSED' };
    const result = classifyProviderError(err);
    expect(result).toMatchObject({ kind: 'transient', retryable: true });
  });

  it('falls back to unknown, not retryable, for an unrecognised Error', () => {
    const result = classifyProviderError(new Error('something weird happened'));
    expect(result).toMatchObject({ kind: 'unknown', retryable: false });
  });

  it('falls back to unknown, not retryable, for a non-Error thrown value', () => {
    const result = classifyProviderError({ weird: true });
    expect(result).toMatchObject({ kind: 'unknown', retryable: false });
  });

  it('never marks any kind other than rate_limit/transient as retryable', () => {
    const nonRetryableKinds: Array<unknown> = [
      apiError({ statusCode: 401 }),
      apiError({ statusCode: 404 }),
      new NoSuchModelError({ modelId: 'x', modelType: 'languageModel' }),
      new UnsupportedFunctionalityError({ functionality: 'x' }),
      new DOMException('aborted', 'AbortError'),
      new Error('mystery'),
    ];
    for (const err of nonRetryableKinds) {
      const result = classifyProviderError(err);
      expect(['rate_limit', 'transient']).not.toContain(result.kind);
      expect(result.retryable).toBe(false);
    }
  });
});
