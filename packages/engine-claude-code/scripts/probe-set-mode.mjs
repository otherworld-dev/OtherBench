// Live probe (SDK 0.3.287): does Query.setPermissionMode('auto') switch a
// running Claude Code process into auto mode, between turns and in the middle
// of one? The hook hands every call on (an empty result, as OtherBench does in
// auto mode); in default mode Claude Code then asks (canUseTool), in auto mode
// its classifier should decide without asking. Each ask is recorded, then
// allowed. The commands write small files in the folder given (use a scratch folder).
//
//   node packages/engine-claude-code/scripts/probe-set-mode.mjs "E:/Git/Some Repo"
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

const cwd = process.argv[2];
if (!cwd) throw new Error('usage: probe-set-mode.mjs <scratch folder>');

const queue = [];
let wake = null;
const input = {
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (queue.length > 0) yield queue.shift();
      await new Promise((r) => (wake = r));
    }
  },
};
const send = (text) => {
  queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid: randomUUID() });
  wake?.();
};

let phase = 'start';
const log = [];
const q = query({
  prompt: input,
  options: {
    cwd,
    model: 'sonnet',
    permissionMode: 'default',
    settingSources: [],
    hooks: { PreToolUse: [{ hooks: [async (i) => { log.push({ phase, hook: `${i.tool_name} ${JSON.stringify(i.tool_input?.command ?? '')}` }); return {}; }] }] },
    canUseTool: async (toolName, toolInput) => {
      log.push({ phase, ask: `${toolName} ${JSON.stringify(toolInput.command ?? '')}` });
      // Mid-turn switch: on the first ask of phase 3, switch to auto, then allow this one.
      if (phase === 'mid-turn' && !log.some((e) => e.phase === 'mid-turn' && e.switched === 'auto')) {
        await q.setPermissionMode('auto');
        log.push({ phase, switched: 'auto' });
      }
      return { behavior: 'allow', updatedInput: toolInput };
    },
  },
});

const turn = (text) => send(text);
// One iterator for the whole run: leaving a for-await loop would close the query.
const it = q[Symbol.asyncIterator]();
const reads = async (stopAfterResults) => {
  let results = 0;
  for (let next = await it.next(); !next.done; next = await it.next()) {
    const m = next.value;
    if (m.type === 'system' && m.subtype === 'init') log.push({ phase, init: m.permissionMode });
    if (m.type === 'system' && m.subtype === 'status') log.push({ phase, status: m.permissionMode ?? m.status });
    if (m.type === 'result') {
      log.push({ phase, result: m.subtype });
      results++;
      if (results >= stopAfterResults) return;
    }
  }
};

phase = 'default';
turn('Run exactly this Bash command once, unchanged, then say done: echo one > probe-1.txt');
await reads(1);

phase = 'after-switch';
await q.setPermissionMode('auto');
log.push({ phase, switched: 'auto' });
turn('Run exactly this Bash command once, unchanged, then say done: echo two > probe-2.txt');
await reads(1);

phase = 'mid-turn';
await q.setPermissionMode('default');
log.push({ phase, switched: 'default' });
turn('Run exactly these two Bash commands, one after the other, each unchanged, as two separate tool calls, then say done: first `echo three > probe-3.txt`, then `echo four > probe-4.txt`');
await reads(1);

q.close?.();
console.log(JSON.stringify(log, null, 2));
process.exit(0);
