/**
 * True for a run_command result from Grunt's sandbox (spec 2026-10-12-sandbox-design):
 * an object with `sandbox: true`, or that object as JSON text (how Claude
 * Code's relay and the mock provider hand results back).
 */
export function isSandboxResult(result: unknown): boolean {
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
