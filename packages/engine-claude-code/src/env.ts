import type { Connection } from '@grunt/core/types/config.js';

/** The `EngineMeta.backend` value for the Claude login (no base URL). */
export const CLAUDE_BACKEND = 'claude';

const CREDENTIAL_VARS = /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/i;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function backendOf(conn: Connection): string {
  return conn.baseUrl ? trimTrailingSlash(conn.baseUrl) : CLAUDE_BACKEND;
}

/**
 * The complete environment for the Claude Code child process. The SDK's `env`
 * option REPLACES the inherited environment, so this copies `base` first.
 * Credential variables are removed in any letter case (Windows env names are
 * case-insensitive) so the Claude backend always uses the login, never API
 * billing. An endpoint backend gets its URL and token, and Claude Code's
 * background "small/fast" model is pointed at the chosen model so it never
 * asks the endpoint for a Claude model id.
 */
export function buildChildEnv(base: NodeJS.ProcessEnv, conn: Connection, token: string | null, modelId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !CREDENTIAL_VARS.test(key)) env[key] = value;
  }
  if (conn.baseUrl) {
    env['ANTHROPIC_BASE_URL'] = trimTrailingSlash(conn.baseUrl);
    env['ANTHROPIC_AUTH_TOKEN'] = token ?? 'grunt-local';
    env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = modelId;
    env['ANTHROPIC_SMALL_FAST_MODEL'] = modelId;
  }
  return env;
}
