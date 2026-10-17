// Live probe for slash commands, compaction and command listing
// (spec 2026-10-17-claude-slash-commands). NOT part of CI.
// Usage: node packages/engine-claude-code/scripts/probe-commands.mjs
// Uses the Claude login: a handful of tiny turns (haiku). Creates its own scratch
// folder under the OS temp dir (refuses one inside a git repo) and deletes it at
// the end. Inline shell in skills/commands is disabled.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'ob-probe-commands-'));
{
  let probeDir = resolve(scratch);
  while (!existsSync(probeDir)) probeDir = dirname(probeDir);
  let top = null;
  try {
    top = execFileSync('git', ['-C', probeDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* not inside a git repo: good */
  }
  if (top) {
    console.error(`Refusing to run: ${scratch} is inside a git repo (${top}).`);
    rmSync(scratch, { recursive: true, force: true });
    process.exit(2);
  }
}

// Same scrubbing as OtherBench's buildChildEnv for the Claude backend.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/i.test(k)) continue;
  if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD)$/i.test(k)) continue;
  env[k] = v;
}

const short = (v, n = 300) => (typeof v === 'string' ? v : JSON.stringify(v ?? null)).slice(0, n);
const textOf = (m) => (Array.isArray(m.message?.content) ? m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '');
const isResult = (e) => typeof e.msg === 'string' && e.msg.startsWith('result');

function folder(name) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Sends each prompt as a turn in one streaming-input process, waiting for the
 * turn's `result` before sending the next. `events` is the ordered log of
 * messages and hook firings. Reads ONE iterator for the whole run.
 */
async function run({ cwd, prompts, model = 'haiku', hooks = {}, maxTurns = 4 }) {
  const events = [];
  const msgs = [];
  const waiters = [];
  let results = 0;
  async function* input() {
    for (const text of prompts) {
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } };
      await new Promise((r) => waiters.push(r));
    }
    await new Promise(() => {});
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 240_000);
  let thrown = null;
  const hookCfg = {};
  for (const name of Object.keys(hooks)) {
    hookCfg[name] = [{ hooks: [async (i) => { events.push({ hook: name, ...hooks[name](i) }); return {}; }] }];
  }
  // Reads inside the scratch folder only; nothing else runs.
  hookCfg.PreToolUse = [{
    hooks: [async (i) => {
      const ok = ['Read', 'Glob', 'Grep', 'Write', 'Edit'].includes(i.tool_name);
      events.push({ hook: 'PreToolUse', tool: i.tool_name, allowed: ok });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: ok ? 'allow' : 'deny', permissionDecisionReason: 'probe policy' } };
    }],
  }];
  const q = query({
    prompt: input(),
    options: {
      cwd, env, model, maxTurns,
      settingSources: ['user', 'project', 'local'],
      settings: { disableSkillShellExecution: true },
      disallowedTools: ['AskUserQuestion', 'Bash'],
      persistSession: true,
      hooks: hookCfg,
      canUseTool: async () => ({ behavior: 'deny', message: 'probe: not allowed' }),
      abortController: ac,
    },
  });
  try {
    for await (const m of q) {
      msgs.push(m);
      const e = { msg: m.type + (m.subtype ? '/' + m.subtype : ''), session_id: m.session_id };
      if (m.type === 'system' && m.subtype === 'compact_boundary') e.compact_metadata = m.compact_metadata;
      if (m.type === 'system' && m.subtype === 'local_command_output') e.content = short(m.content);
      if (m.type === 'assistant') e.text = short(textOf(m), 200);
      if (m.type === 'result') e.result = { subtype: m.subtype, is_error: m.is_error, terminal_reason: m.terminal_reason, text: short(m.result, 300), num_turns: m.num_turns };
      events.push(e);
      if (m.type === 'result') {
        results++;
        waiters.shift()?.();
        if (results >= prompts.length) break;
      }
    }
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { events, msgs, thrown };
}

const out = {};

// Q1: manual compaction in one streaming process.
{
  const r = await run({
    cwd: folder('q1'),
    prompts: ['reply with pong', '/compact keep the word pong'],
    hooks: { PostCompact: (i) => ({ trigger: i.trigger, summary_len: (i.compact_summary ?? '').length, summary_head: short(i.compact_summary, 160), session_id: i.session_id }) },
  });
  const firstResult = r.events.findIndex(isResult);
  const secondResult = r.events.findIndex((e, i) => isResult(e) && i > firstResult);
  const hookAt = r.events.findIndex((e) => e.hook === 'PostCompact');
  out.Q1 = {
    sequence: r.events.map((e) => e.hook ?? e.msg),
    postCompactHook: r.events.find((e) => e.hook === 'PostCompact') ?? null,
    hookBeforeCompactResult: hookAt >= 0 && secondResult >= 0 && hookAt < secondResult,
    compactBoundary: r.events.find((e) => e.msg === 'system/compact_boundary')?.compact_metadata ?? null,
    initCount: r.events.filter((e) => e.msg === 'system/init').length,
    sessionIds: [...new Set(r.events.filter((e) => e.session_id).map((e) => e.session_id))].length,
    results: r.events.filter(isResult).map((e) => e.result),
    localCommandOutput: r.events.filter((e) => e.msg === 'system/local_command_output').map((e) => e.content),
    thrown: r.thrown,
  };
  console.log(JSON.stringify({ Q1: out.Q1 }));
}

// Q2: project command first, history after.
{
  const cwd = folder('q2');
  mkdirSync(join(cwd, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'commands', 'echo-args.md'), 'Reply with the word you were told about in the history.\n');
  const r = await run({
    cwd,
    prompts: ['/echo-args\n\n<otherbench-history>\nUser: remember the word "zebra".\nAssistant: Noted, the word is zebra.\n</otherbench-history>'],
    hooks: { UserPromptExpansion: (i) => ({ expansion: short(i, 300) }) },
  });
  const init = r.msgs.find((m) => m.type === 'system' && m.subtype === 'init');
  const result = r.events.find(isResult)?.result ?? null;
  out.Q2 = {
    commandListed: (init?.slash_commands ?? []).includes('echo-args'),
    expansionHook: r.events.find((e) => e.hook === 'UserPromptExpansion') ?? null,
    assistantTexts: r.events.filter((e) => e.msg === 'assistant').map((e) => e.text),
    result,
    namesZebra: /zebra/i.test(result?.text ?? ''),
    thrown: r.thrown,
  };
  console.log(JSON.stringify({ Q2: out.Q2 }));
}

// Q3: built-in commands as turns, in a throwaway git repo inside the scratch folder.
{
  out.Q3 = {};
  for (const name of ['init', 'review', 'security-review', 'context']) {
    const cwd = folder('q3-' + name);
    writeFileSync(join(cwd, 'app.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
    const g = (...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=probe', '-c', 'user.email=probe@example.com', ...a], { stdio: 'ignore' });
    g('init', '-q'); g('add', '.'); g('commit', '-q', '-m', 'init');
    writeFileSync(join(cwd, 'app.js'), 'export function add(a, b) {\n  return a + b;\n}\nexport const sub = (a, b) => a - b;\n');
    const r = await run({ cwd, prompts: ['/' + name], maxTurns: 3 });
    out.Q3[name] = {
      sequence: r.events.map((e) => (e.hook ? `${e.hook}:${e.tool ?? ''}` : e.msg)),
      modelTurn: r.events.some((e) => e.msg === 'assistant'),
      assistantHead: r.events.filter((e) => e.msg === 'assistant').map((e) => e.text).slice(0, 2),
      localCommandOutput: r.events.filter((e) => e.msg === 'system/local_command_output').map((e) => e.content.slice(0, 160)),
      result: r.events.find(isResult)?.result ?? null,
      claudeMdWritten: name === 'init' ? existsSync(join(cwd, 'CLAUDE.md')) : undefined,
      thrown: r.thrown,
    };
    console.log(JSON.stringify({ ['Q3_' + name]: out.Q3[name] }));
  }
}

// Q4: idle query with a SessionStart hook in project settings and no prompt.
{
  const cwd = folder('q4');
  const marker = join(cwd, 'session-start-marker.txt').replace(/\\/g, '/');
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const command = `node -e "require('fs').writeFileSync(process.argv[1], 'fired')" "${marker}"`;
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }));
  const ac = new AbortController();
  const idle = (async function* () { await new Promise(() => {}); })();
  const q = query({ prompt: idle, options: { cwd, env, settingSources: ['user', 'project', 'local'], settings: { disableSkillShellExecution: true }, persistSession: false, abortController: ac } });
  let cmds = null;
  let err = null;
  try { cmds = await q.supportedCommands(); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  await new Promise((r) => setTimeout(r, 3000));
  const markerExists = existsSync(marker);
  ac.abort();
  out.Q4 = {
    markerExistsAfterSupportedCommands: markerExists,
    error: err,
    commands: (cmds ?? []).map((c) => ({ name: c.name, builtin: c.builtin === true, aliases: c.aliases ?? [] })),
  };
  console.log(JSON.stringify({ Q4: out.Q4 }));
}

await new Promise((r) => setTimeout(r, 3000)); // let child processes release the folder
rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
console.log(JSON.stringify({ scratchDeleted: !existsSync(scratch) }));
process.exit(0);
