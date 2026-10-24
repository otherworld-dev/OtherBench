import type { Connection } from '@otherbench/core/types/config.js';
import { isServerOnlyEnvVar } from '@otherbench/core/domain/child-env.js';

/** The `EngineMeta.backend` value for the Claude login (no base URL). */
export const CLAUDE_BACKEND = 'claude';

const CREDENTIAL_VARS = /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/i;
/**
 * Set when OtherBench itself was started from inside a Claude Code session. Passed
 * on, they would make the child think it is nested in that session (or attach
 * to its IDE port) instead of being a fresh top-level run.
 */
const PARENT_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT)$/i;
/**
 * Makes Claude Code read CLAUDE.md from each `additionalDirectories` entry.
 * OtherBench passes none (a chat's extra folders are folders to work in, never
 * configuration), and this keeps it so if one is ever passed.
 */
const ADDED_DIR_CONFIG_VARS = /^CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD$/i;
/**
 * Moves an MCP call that runs past this many ms to the background. A relayed
 * call (a generation above all) must finish as the call the reply is waiting
 * on, so it is always set to 0 (off), whatever OtherBench's own environment says.
 */
const AUTO_BACKGROUND_VAR = 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS';
const AUTO_BACKGROUND_VARS = /^CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS$/i;

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
 * billing. Variables marking a parent Claude Code session, and the switch that
 * loads an extra folder's CLAUDE.md, are removed for every backend. An endpoint backend gets its URL and token, and Claude Code's
 * background "small/fast" model is pointed at the chosen model so it never
 * asks the endpoint for a Claude model id. Every backend also gets Claude
 * Code's todo tools switched on, and its moving of long MCP calls to the
 * background switched off.
 */
export function buildChildEnv(base: NodeJS.ProcessEnv, conn: Connection, token: string | null, modelId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    // The server's own API token (OTHERBENCH_TOKEN) never reaches Claude Code or its Bash (core/domain/child-env.ts).
    if (value !== undefined && !CREDENTIAL_VARS.test(key) && !PARENT_SESSION_VARS.test(key) && !ADDED_DIR_CONFIG_VARS.test(key) && !AUTO_BACKGROUND_VARS.test(key) && !isServerOnlyEnvVar(key)) env[key] = value;
  }
  if (conn.baseUrl) {
    env['ANTHROPIC_BASE_URL'] = trimTrailingSlash(conn.baseUrl);
    env['ANTHROPIC_AUTH_TOKEN'] = token ?? 'otherbench-local';
    env['ANTHROPIC_DEFAULT_HAIKU_MODEL'] = modelId;
    env['ANTHROPIC_SMALL_FAST_MODEL'] = modelId;
  }
  // Newer models aren't offered TodoWrite in SDK sessions; this turns it on
  // for every model (probe: test/fixtures/README.md, "Thread tools"). OtherBench
  // shows the list as the reply's checklist.
  env['CLAUDE_CODE_ENABLE_TODO_TOOLS'] = '1';
  env[AUTO_BACKGROUND_VAR] = '0';
  return env;
}
