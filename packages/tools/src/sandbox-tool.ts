import { isSandboxError, type Sandbox } from '@grunt/core/ports/sandbox.js';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import { sandboxHostsOf, type ToolPolicy } from '@grunt/core/types/config.js';
import { parseRunCommandArgs, RUN_COMMAND_PARAMETERS, toolError } from './shell-tool.js';

export const SANDBOX_NETWORK_TOOL = 'sandbox_network';

/**
 * The approval a host off the profile's allowlist becomes (spec
 * 2026-10-12-sandbox-design, "Network pseudo-tool"). It is never executed,
 * only decided, carded and audited; the sandbox runtime makes the connection.
 */
export const SANDBOX_NETWORK_SPEC: ToolSpec = {
  name: SANDBOX_NETWORK_TOOL,
  description: "A sandboxed command wants to reach a host that isn't on the profile's allowlist.",
  parameters: { type: 'object', properties: { host: { type: 'string' }, port: { type: 'integer' } }, required: ['host'] },
  risk: 'mutate',
  source: 'network',
  execute: async () => {
    throw new Error('sandbox_network is an approval, not a tool to run.');
  },
};

export const SANDBOX_RUN_COMMAND_DESCRIPTION =
  "Runs a command with bash in a Linux sandbox (not on this machine), starting in the workspace folder. The chat's folders appear there under /mnt/<drive>/... (E:\\Git\\x is /mnt/e/Git/x); nothing else from this machine is there, and Windows programs (cmd.exe, PowerShell, .exe files) aren't available. " +
  'Default timeout 120s (hard cap 600s); combined stdout+stderr is captured up to 100KB. A timeout or a cancel kills the command and everything it started. ' +
  "Network access is limited to an allowlist; reaching any other host asks the user first. Things installed under the home folder (pip install --user, a venv, npm's cache) stay for the rest of the chat.";

/**
 * Raises the sandbox_network card for one host and resolves whether the
 * connection may go ahead. `signal` aborts when the sandbox no longer needs
 * the answer; the card is withdrawn then and the answer is no.
 */
export type AskHost = (host: string, port: number | undefined, ctx: ToolContext, signal?: AbortSignal) => Promise<boolean>;

/**
 * `run_command` when the profile's shell runs in the sandbox: the same name
 * and arguments as the host tool, source 'sandbox'. Built per listing because
 * it needs the policy (the allowlist, whether files are writable) and the
 * provider's way of raising a network card.
 *
 * It never runs anything on this machine: with no sandbox, one that isn't set
 * up, or one that fails, the call is refused, never handed to the host shell.
 */
export function sandboxRunCommandTool(sandbox: Sandbox | null, policy: ToolPolicy, askHost: AskHost): ToolSpec {
  return {
    name: 'run_command',
    description: SANDBOX_RUN_COMMAND_DESCRIPTION,
    parameters: RUN_COMMAND_PARAMETERS,
    risk: 'execute',
    source: 'sandbox',
    async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
      const parsed = parseRunCommandArgs(args);
      if ('error' in parsed) return parsed;
      if (!ctx.workspaceRoot) return toolError('spawn_failed', 'run_command requires a workspace root, and none is configured for this chat.');
      if (ctx.signal.aborted) return toolError('aborted', 'The turn was cancelled before this command started, so it was not run.');
      if (!sandbox) return toolError('unsupported', "The sandbox isn't available on this platform yet.");
      try {
        return await sandbox.run({
          chatId: ctx.chatId,
          command: parsed.command,
          timeoutMs: parsed.timeoutMsUsed,
          workspaceRoot: ctx.workspaceRoot,
          folders: ctx.folders ?? [],
          writable: policy.fs === 'readwrite',
          allowedHosts: sandboxHostsOf(policy),
          signal: ctx.signal,
          askHost: (host, port, signal) => askHost(host, port, ctx, signal),
        });
      } catch (err) {
        if (isSandboxError(err)) return toolError(err.code, err.message);
        return toolError('sandbox_failed', err instanceof Error ? err.message : String(err));
      }
    },
  };
}
