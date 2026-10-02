import { createHash } from 'node:crypto';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Connection } from '@grunt/core/types/config.js';

/** The default base URL Ollama serves its OpenAI-compatible surface on. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';

/** Thrown when a `Connection` is missing configuration the chosen kind requires. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * The union of AI SDK provider instances the registry can hand back. All
 * four share the same call shape (`provider(modelId) => LanguageModelV3`)
 * even though their TypeScript types are otherwise unrelated, which is all
 * a caller needs to obtain a model.
 */
export type AiSdkProvider =
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createGoogleGenerativeAI>
  | ReturnType<typeof createOpenAICompatible>;

/**
 * What `ProviderRegistry.resolve` returns. `mock` has no AI SDK provider at
 * all -- the mock engine (task 13) implements the `ChatEngine` port
 * directly rather than going through the `ai` package -- so callers must
 * branch on `kind` before doing anything AI-SDK-shaped with the result.
 */
export type ProviderHandle = { kind: 'mock' } | { kind: 'aisdk'; provider: AiSdkProvider };

interface CacheEntry {
  credentialHash: string;
  handle: ProviderHandle;
}

/**
 * Hashes the parts of a connection that, if edited, should invalidate a
 * cached provider instance (an existing instance has already captured the
 * old values in its closure, so it must be rebuilt rather than reused).
 * `connection.id` is deliberately NOT part of this hash -- it is the cache
 * key itself, hashed separately -- since a connection's id never changes
 * across an edit.
 *
 * Included fields, and why each one can change the resulting provider
 * instance:
 *  - `kind` -- selects which AI SDK factory (`createAnthropic`,
 *    `createOpenAI`, etc.) builds the instance. Editing just the provider
 *    dropdown on an otherwise-untouched connection (baseUrl/apiKey/headers
 *    all unchanged) must still invalidate the cache, or `resolve()` hands
 *    back an instance built from the WRONG SDK for the new kind.
 *  - `baseUrl`, `apiKey`, `extraHeaders` -- baked directly into every
 *    factory call.
 *  - `name` -- for `openai_compatible` and `ollama`, `buildProvider` passes
 *    `connection.name` as the `name` option to `createOpenAICompatible`,
 *    which the AI SDK bakes into the model's `provider` string and derives
 *    `providerOptionsName` from (the namespace it reads per-call
 *    `providerOptions` under). A rename with everything else unchanged
 *    would otherwise keep serving an instance that still answers to the old
 *    name, silently dropping any provider-specific options callers pass
 *    under the new name.
 *
 * `secretRef`, `status`, `statusMessage`, and `checkedAt` are NOT included:
 * none of them are read by `buildProvider`, so they cannot affect the
 * resulting instance.
 */
function hashCredentials(
  kind: Connection['kind'],
  name: string,
  baseUrl: string | null,
  apiKey: string | null,
  extraHeaders: Record<string, string>
): string {
  const sortedHeaders = Object.keys(extraHeaders)
    .sort()
    .map((key) => [key, extraHeaders[key]]);
  const payload = JSON.stringify({ kind, name, baseUrl, apiKey, headers: sortedHeaders });
  return createHash('sha256').update(payload).digest('hex');
}

function buildProvider(connection: Connection, apiKey: string | null): ProviderHandle {
  const headers = connection.extraHeaders;
  const resolvedApiKey = apiKey ?? undefined;

  switch (connection.kind) {
    case 'anthropic':
      return {
        kind: 'aisdk',
        provider: createAnthropic({
          apiKey: resolvedApiKey,
          baseURL: connection.baseUrl ?? undefined,
          headers,
        }),
      };

    case 'openai':
      return {
        kind: 'aisdk',
        provider: createOpenAI({
          apiKey: resolvedApiKey,
          baseURL: connection.baseUrl ?? undefined,
          headers,
        }),
      };

    case 'google':
      return {
        kind: 'aisdk',
        provider: createGoogleGenerativeAI({
          apiKey: resolvedApiKey,
          baseURL: connection.baseUrl ?? undefined,
          headers,
        }),
      };

    case 'openai_compatible': {
      if (!connection.baseUrl) {
        throw new ConfigError(
          `Connection "${connection.name}" (${connection.id}) is kind "openai_compatible" but has no baseUrl configured. ` +
            'An OpenAI-compatible connection must specify the base URL of the server it talks to.'
        );
      }
      return {
        kind: 'aisdk',
        provider: createOpenAICompatible({
          name: connection.name,
          baseURL: connection.baseUrl,
          apiKey: resolvedApiKey,
          headers,
        }),
      };
    }

    case 'ollama':
      // Ollama has no dedicated AI SDK provider package; it speaks an
      // OpenAI-compatible surface, so it is wired through the same factory
      // as openai_compatible, just with a default local baseURL and no key
      // required.
      return {
        kind: 'aisdk',
        provider: createOpenAICompatible({
          name: connection.name,
          baseURL: connection.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
          apiKey: resolvedApiKey,
          headers,
        }),
      };

    case 'claude_code':
      throw new ConfigError(
        `Connection "${connection.name}" is a Claude Code connection; it is served by ClaudeCodeChatEngine, not the AI SDK registry.`
      );

    case 'mock':
      return { kind: 'mock' };

    default: {
      const exhaustive: never = connection.kind;
      throw new ConfigError(`Unknown connection kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Maps `Connection`s to AI SDK provider instances (or, for kind `mock`, to
 * a marker with no AI SDK provider behind it), caching each instance by
 * connection id so repeated requests for the same connection reuse the
 * same provider object -- important because provider instances hold open
 * fetch configuration, not because construction is expensive.
 *
 * The cache is invalidated per-connection whenever anything baked into the
 * cached instance changes -- kind, name, base URL, API key, or extra
 * headers (see {@link hashCredentials} for why each of those, specifically,
 * can change the resulting instance) -- so editing a connection's provider
 * kind or key in the UI and retrying immediately picks up the change rather
 * than replaying a stale instance built from the old one.
 */
export class ProviderRegistry {
  private readonly cache = new Map<string, CacheEntry>();

  resolve(connection: Connection, apiKey: string | null): ProviderHandle {
    const credentialHash = hashCredentials(
      connection.kind,
      connection.name,
      connection.baseUrl,
      apiKey,
      connection.extraHeaders
    );
    const cached = this.cache.get(connection.id);
    if (cached && cached.credentialHash === credentialHash) {
      return cached.handle;
    }

    const handle = buildProvider(connection, apiKey);
    this.cache.set(connection.id, { credentialHash, handle });
    return handle;
  }

  /** Drops every cached provider instance. Mainly useful for tests. */
  clear(): void {
    this.cache.clear();
  }
}
