/**
 * What no process OtherBench starts may inherit from the server's environment.
 *
 * The desktop shell hands the server its per-launch API token as
 * `OTHERBENCH_TOKEN`. On the desktop server that token is the real barrier
 * against a browser tab or another program on the machine driving OtherBench's
 * API (approving its own cards, adding an MCP server that runs a command).
 * `otherbench serve` deletes it from `process.env` as soon as it has read it, and
 * every place that starts a process also leaves it out explicitly
 * (`withoutServerSecrets`): a host `run_command`, Claude Code and its Bash,
 * an MCP stdio server, the sandbox's `wsl.exe`, the model's browser. Names
 * are matched in any letter case, as Windows treats them.
 */
export const SERVER_ONLY_ENV_VARS: readonly string[] = Object.freeze(['OTHERBENCH_TOKEN']);

/** Whether an environment variable's name is one no child process may see. */
export function isServerOnlyEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  return SERVER_ONLY_ENV_VARS.includes(upper);
}

/** A copy of `env` without the server-only variables and without unset entries. */
export function withoutServerSecrets(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isServerOnlyEnvVar(name)) out[name] = value;
  }
  return out;
}
