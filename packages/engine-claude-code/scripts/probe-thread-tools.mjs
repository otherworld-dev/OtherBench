// Live probe for the thread-cards spec's Task 1
// (docs/superpowers/specs/2026-10-12-thread-cards-design.md §1). NOT part of CI.
// Usage: node packages/engine-claude-code/scripts/probe-thread-tools.mjs [scratch-dir]
// Uses the Claude login: four short haiku turns and three one-word sonnet turns.
// Transcripts go to <scratch-dir>/probe-*.json; a VERDICT is printed at the end.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const scratch = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'otherbench-probe-thread-'));
{
  // The scratch dir must be outside any git repo.
  let probeDir = scratch;
  while (!existsSync(probeDir)) probeDir = dirname(probeDir);
  let top = null;
  try {
    top = execFileSync('git', ['-C', probeDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* not inside a git repo: good */
  }
  if (top) {
    console.error(`Refusing to run: ${scratch} is inside a git repo (${top}). Use a fresh directory under the OS temp folder.`);
    process.exit(2);
  }
}
mkdirSync(scratch, { recursive: true });

// Same scrubbing as OtherBench's buildChildEnv for the Claude backend.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/i.test(k)) continue;
  if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT)$/i.test(k)) continue;
  env[k] = v;
}

const ASK_PROMPT =
  'Use the AskUserQuestion tool to ask me exactly one question, "Which colour do you prefer?", with exactly two options, Red and Blue. Use no other tool. After I answer, reply with only the colour I chose.';
const PONG = 'Reply with exactly: pong';
const DENY_REASON = 'PROBE-DENIED: nobody is here to answer.';

function oneShot(text) {
  let done;
  const finished = new Promise((r) => (done = r));
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } };
    await finished;
  }
  return { input: input(), done: () => done() };
}

const blueAnswers = (toolInput) => Object.fromEntries((toolInput?.questions ?? []).map((q) => [q.question, 'Blue']));

async function run(name, { text, model, options = {}, hook, canUse }) {
  const { input, done } = oneShot(text);
  const seen = { hook: [], canUseTool: [] };
  const out = [];
  const stderr = [];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 180_000);
  let thrown = null;
  try {
    const q = query({
      prompt: input,
      options: {
        cwd: scratch,
        env,
        model,
        permissionMode: 'default',
        settingSources: [],
        persistSession: false,
        ...options,
        hooks: {
          PreToolUse: [{ hooks: [async (i, toolUseId) => {
            seen.hook.push({ tool: i.tool_name, toolUseId: toolUseId ?? i.tool_use_id ?? null });
            const d = hook(i);
            return d ? { hookSpecificOutput: { hookEventName: 'PreToolUse', ...d } } : {};
          }], timeout: 600 }],
        },
        canUseTool: async (toolName, toolInput, opts) => {
          seen.canUseTool.push({ tool: toolName, toolUseID: opts?.toolUseID ?? null });
          return canUse(toolName, toolInput);
        },
        abortController: ac,
        stderr: (d) => { stderr.push(d); if (stderr.length > 30) stderr.shift(); },
      },
    });
    for await (const m of q) { out.push(m); if (m.type === 'result') done(); }
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    done();
  }
  writeFileSync(join(scratch, `probe-${name}.json`), JSON.stringify(out, null, 2));
  const init = out.find((m) => m.type === 'system' && m.subtype === 'init');
  const result = out.find((m) => m.type === 'result');
  const askUses = out
    .filter((m) => m.type === 'assistant' && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content)
    .filter((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion')
    .map((b) => b.id);
  const toolResults = out
    .filter((m) => m.type === 'user' && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content)
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({ toolUseId: b.tool_use_id, isError: b.is_error === true, text: (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 300) }));
  const summary = {
    name,
    model,
    initTools: init?.tools ?? null,
    resultSubtype: result?.subtype ?? null,
    permissionDenials: (result?.permission_denials ?? []).map((d) => d.tool_name),
    hookCalls: seen.hook,
    canUseToolCalls: seen.canUseTool,
    askUses,
    toolResults,
    finalText: typeof result?.result === 'string' ? result.result.slice(0, 200) : null,
    thrown,
    stderrTail: stderr.join('').slice(-600),
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

const answerBlueInHook = (i) =>
  i.tool_name === 'AskUserQuestion'
    ? { permissionDecision: 'allow', permissionDecisionReason: 'Answered in OtherBench', updatedInput: { ...i.tool_input, answers: blueAnswers(i.tool_input) } }
    : { permissionDecision: 'allow', permissionDecisionReason: 'ok' };
const answerBlueInCanUse = (toolName, toolInput) =>
  toolName === 'AskUserQuestion' ? { behavior: 'allow', updatedInput: { ...toolInput, answers: blueAnswers(toolInput) } } : { behavior: 'allow', updatedInput: toolInput };
const allowAll = () => ({ permissionDecision: 'allow', permissionDecisionReason: 'ok' });
const denyInCanUse = () => ({ behavior: 'deny', message: 'denied by probe canUseTool' });
const has = (r, tool) => (r.initTools ?? []).includes(tool);
const answeredBlue = (r) => r.askUses.length > 0 && r.toolResults.some((t) => r.askUses.includes(t.toolUseId) && !t.isError && /Blue/.test(t.text));
const askViaCanUse = (r) => r.canUseToolCalls.some((c) => c.tool === 'AskUserQuestion');

// Steps 1 and 5: the hook answers; the plan tools are disallowed.
const s1 = await run('s1-hook-answers', { text: ASK_PROMPT, model: 'haiku', options: { disallowedTools: ['EnterPlanMode', 'ExitPlanMode'] }, hook: answerBlueInHook, canUse: answerBlueInCanUse });
// Step 2: the hook refuses with a reason.
const s2 = await run('s2-hook-denies', {
  text: ASK_PROMPT,
  model: 'haiku',
  hook: (i) => (i.tool_name === 'AskUserQuestion' ? { permissionDecision: 'deny', permissionDecisionReason: DENY_REASON } : allowAll()),
  canUse: denyInCanUse,
});
// Step 3: todos on a newer model, as a folder chat starts it.
const folder = { settingSources: ['user', 'project', 'local'], settings: { disableSkillShellExecution: true } };
const s3base = await run('s3-sonnet-default', { text: PONG, model: 'sonnet', options: folder, hook: allowAll, canUse: denyInCanUse });
const s3env = await run('s3-sonnet-env-flag', { text: PONG, model: 'sonnet', options: { ...folder, env: { ...env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } }, hook: allowAll, canUse: denyInCanUse });
const s3allowed = await run('s3-sonnet-allowed-tools', { text: PONG, model: 'sonnet', options: { ...folder, allowedTools: ['TodoWrite'] }, hook: allowAll, canUse: denyInCanUse });
// Step 4: a clean chat's tool list.
const s4 = await run('s4-clean-chat', {
  text: ASK_PROMPT,
  model: 'haiku',
  options: { strictMcpConfig: true, tools: ['WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion'] },
  hook: answerBlueInHook,
  canUse: answerBlueInCanUse,
});

const askOk = answeredBlue(s1) && answeredBlue(s4);
console.log('\n=== VERDICT ===');
console.log(JSON.stringify({
  step1: { answeredBlue: answeredBlue(s1), askReachedCanUseTool: askViaCanUse(s1), haikuDefaultHasTodoWrite: has(s1, 'TodoWrite') },
  step2: { deniedWithReason: s2.toolResults.some((t) => t.isError && t.text.includes('PROBE-DENIED')), turnCarriedOn: s2.resultSubtype === 'success' },
  step3: {
    defaultHasTodoWrite: has(s3base, 'TodoWrite'),
    envFlagHasTodoWrite: has(s3env, 'TodoWrite'),
    allowedToolsHasTodoWrite: has(s3allowed, 'TodoWrite'),
    taskCreateSeen: [s3base, s3env, s3allowed].some((r) => has(r, 'TaskCreate')),
  },
  step4: { listsAllFour: ['WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion'].every((t) => has(s4, t)), answeredBlue: answeredBlue(s4), askReachedCanUseTool: askViaCanUse(s4) },
  step5: { planToolsHidden: !has(s1, 'EnterPlanMode') && !has(s1, 'ExitPlanMode') },
  ASK_PATH: askOk ? (askViaCanUse(s1) || askViaCanUse(s4) ? 'canUseTool' : 'hook') : 'fallback',
  TODO_FLAG: has(s3env, 'TodoWrite') ? 'env' : has(s3allowed, 'TodoWrite') ? 'allowedTools' : 'fallback',
}, null, 2));
