/** run_command, as the API engines name it, or as Claude Code calls it on OtherBench's relay (`mcp__otherbench_<16 hex>__run_command`). */
const RUN_COMMAND = /^(?:run_command|mcp__otherbench_[0-9a-f]{16}__run_command)$/;

/**
 * True for a run_command result from OtherBench's sandbox (spec 2026-10-12-sandbox-design):
 * an object with `sandbox: true`, or that object as JSON text (how Claude
 * Code's relay and the mock provider hand results back). Only run_command's:
 * any other tool (an MCP server's, say) can return `sandbox: true` too, and
 * must not get the badge that says it ran in the sandbox.
 */
export function isSandboxResult(toolName: string, result: unknown): boolean {
  if (!RUN_COMMAND.test(toolName)) return false;
  let value = result;
  if (typeof value === 'string') {
    if (!value.trimStart().startsWith('{')) return false;
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return false;
    }
  }
  return typeof value === 'object' && value !== null && (value as { sandbox?: unknown }).sandbox === true;
}
