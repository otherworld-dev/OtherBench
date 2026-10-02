// Live probe against the real Claude Code install. NOT part of CI.
// Usage: node packages/engine-claude-code/scripts/record-fixtures.mjs <scratch-dir>
// Records SDK message sequences into test/fixtures and prints the answers to
// the spec's §6 open items. Uses haiku on the Claude login.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'test', 'fixtures');
const scratch = process.argv[2];
if (!scratch) throw new Error('pass a scratch directory to use as cwd');
mkdirSync(scratch, { recursive: true });
writeFileSync(join(scratch, 'hello.txt'), 'hello\n');

const env = { ...process.env };
for (const k of Object.keys(env)) if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/i.test(k)) delete env[k];

function oneShot(text) {
  let done;
  const finished = new Promise((r) => (done = r));
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } };
    await finished;
  }
  return { input: input(), done: () => done() };
}

async function record(name, text, decide, extra = {}) {
  const { input, done } = oneShot(text);
  const hookCalls = [];
  const canUseCalls = [];
  const out = [];
  const q = query({
    prompt: input,
    options: {
      cwd: scratch, env, model: 'haiku', permissionMode: 'default', includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      hooks: { PreToolUse: [{ hooks: [async (i) => {
        hookCalls.push(i.tool_name);
        const allow = decide(i.tool_name);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: allow ? 'ok' : 'denied by probe' } };
      }] }] },
      canUseTool: async (n, input) => { canUseCalls.push(n); return { behavior: 'allow', updatedInput: input }; },
      ...extra,
    },
  });
  for await (const m of q) { out.push(m); if (m.type === 'result') done(); }
  writeFileSync(join(fixtures, `${name}.json`), JSON.stringify(out, null, 2));
  const init = out.find((m) => m.type === 'system' && m.subtype === 'init');
  console.log(`[${name}] session=${init?.session_id} hookCalls=${hookCalls.join(',')} canUseToolCalls=${canUseCalls.join(',')}`);
  return init?.session_id;
}

mkdirSync(fixtures, { recursive: true });
const s1 = await record('text-turn', 'Reply with exactly: pong', () => true);
await record('tool-turn', 'Read hello.txt, then use Bash to run: echo grunt-probe. Then append the line "world" to hello.txt with Edit.', () => true);
await record('denied-tool-turn', 'Use Bash to run: echo should-be-denied', (n) => n !== 'Bash');
// §6 item 5: resume the first session with a different model, in place.
await record('resume-other-model', 'What did I ask you to reply with before?', () => true, { resume: s1, model: 'sonnet' });

// §6 item 3: supportedModels/accountInfo without sending a prompt.
{
  const { input, done } = oneShot('unused');
  const idle = (async function* () { await new Promise(() => {}); })();
  const ac = new AbortController();
  const q = query({ prompt: idle, options: { env, settingSources: [], persistSession: false, abortController: ac } });
  console.log('supportedModels', JSON.stringify(await q.supportedModels()));
  console.log('accountInfo', JSON.stringify(await q.accountInfo()));
  ac.abort();
  done();
  void input;
}
console.log('Now check §6 item 4 by hand: run `claude --help` / docs for the small-fast model env var names on a custom ANTHROPIC_BASE_URL.');
