// Live probe (SDK 0.3.287): in auto mode, with OtherBench's hook handing every
// call to the classifier (an empty hook result), which Bash commands does
// Claude Code still raise a permission prompt for (canUseTool), and why?
// Each prompt is recorded with the options Claude Code passed, then denied.
// The commands are read-only git queries in the folder given.
//
//   node packages/engine-claude-code/scripts/probe-auto-ask.mjs "E:/Git/Some Repo"
import { query } from '@anthropic-ai/claude-agent-sdk';

const cwd = process.argv[2];
if (!cwd) throw new Error('usage: probe-auto-ask.mjs <git folder>');

const COMMANDS = [
  `cd "${cwd}" && git tag --sort=-creatordate | head -5 && git log --oneline -i --grep=colo -20`,
  `git tag --sort=-creatordate | head -5 && git log --oneline -i --grep=colo -20`,
  `cd "${cwd}" && git status --short`,
];

for (const command of COMMANDS) {
  const hookCalls = [];
  const asks = [];
  const q = query({
    prompt: `Run exactly this one Bash command, unchanged, once, and then say "done". Do not run anything else.\n\n${command}`,
    options: {
      cwd,
      model: 'sonnet',
      permissionMode: 'auto',
      settingSources: ['user', 'project', 'local'],
      hooks: { PreToolUse: [{ hooks: [async (input) => { hookCalls.push(`${input.tool_name}: ${JSON.stringify(input.tool_input).slice(0, 160)}`); return {}; }] }] },
      canUseTool: async (toolName, input, options) => {
        const { signal: _signal, ...rest } = options;
        asks.push({ toolName, input, options: rest });
        return { behavior: 'deny', message: 'PROBE: denied at the permission prompt.' };
      },
    },
  });
  let mode = null;
  let terminal = null;
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') mode = m.permissionMode;
    if (m.type === 'result') terminal = { subtype: m.subtype, terminal_reason: m.terminal_reason, denials: m.permission_denials };
  }
  console.log(JSON.stringify({ command, mode, hookCalls, asks, terminal }, null, 2));
}
