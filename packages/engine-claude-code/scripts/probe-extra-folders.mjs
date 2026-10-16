// Live probe for extra folders (spec 2026-10-07-extra-folders, Deck #839). NOT part of CI.
// Usage: node packages/engine-claude-code/scripts/probe-extra-folders.mjs <scratch-dir>
// Uses the Claude login: three short turns. Question: if OtherBench stops passing a
// chat's extra folders as `additionalDirectories` (so Claude Code loads no
// skills or commands from them), can Claude Code still read and write in them
// when OtherBench's PreToolUse hook allows the call? The workspace (cwd) and the
// other folder each carry a probe skill and command; init lists what loaded.
// Transcripts go to <scratch-dir>/probe-*.json.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const scratch = process.argv[2];
if (!scratch) throw new Error('pass a scratch directory');

// The scratch dir must be OUTSIDE any git repo.
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
    console.error(`Refusing to run: ${scratch} is inside a git repo (${top}). Use a fresh directory under the OS temp folder.`);
    process.exit(2);
  }
}

const ws = resolve(scratch, 'ws');
const other = resolve(scratch, 'other');
function seedConfig(dir, tag) {
  mkdirSync(join(dir, '.claude', 'skills', `${tag}-probe-skill`), { recursive: true });
  writeFileSync(join(dir, '.claude', 'skills', `${tag}-probe-skill`, 'SKILL.md'), `---\nname: ${tag}-probe-skill\ndescription: Probe skill from the ${tag} folder. Never use it.\n---\n\nDo nothing.\n`);
  mkdirSync(join(dir, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'commands', `${tag}-probe-cmd.md`), `Probe command from the ${tag} folder. Do nothing.\n`);
}
mkdirSync(ws, { recursive: true });
mkdirSync(other, { recursive: true });
seedConfig(ws, 'ws');
seedConfig(other, 'other');
writeFileSync(join(other, 'notes.txt'), 'THE MAP IS IN THE OTHER FOLDER\n');

// Same scrubbing as OtherBench's buildChildEnv for the Claude backend.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/i.test(k)) continue;
  if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD)$/i.test(k)) continue;
  env[k] = v;
}

function oneShot(text) {
  let done;
  const finished = new Promise((r) => (done = r));
  async function* input() {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } };
    await finished;
  }
  return { input: input(), done: () => done() };
}

const MUTATING = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * `hook`: 'allow' answers allow for every call (OtherBench in default mode, once
 * approved). 'otherbench-auto' allows reads and hands mutating calls to Claude
 * Code with no decision (OtherBench in auto mode for a call it would ask about).
 * canUseTool records the call and allows it (OtherBench would show a card).
 */
async function run(name, { text, model, permissionMode, hook, addDir }) {
  rmSync(join(other, 'out.txt'), { force: true });
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
        cwd: ws,
        ...(addDir ? { additionalDirectories: [other] } : {}),
        env,
        model,
        permissionMode,
        settingSources: ['user', 'project', 'local'],
        settings: { disableSkillShellExecution: true },
        disallowedTools: ['AskUserQuestion'],
        persistSession: false,
        hooks: {
          PreToolUse: [{ hooks: [async (i) => {
            seen.hook.push(i.tool_name);
            if (hook === 'otherbench-auto' && MUTATING.has(i.tool_name)) return {};
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved in OtherBench' } };
          }], timeout: 600 }],
        },
        canUseTool: async (n, input) => { seen.canUseTool.push(n); return { behavior: 'allow', updatedInput: input }; },
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
  const probeNames = (list) => (list ?? []).filter((s) => /probe/.test(s));
  const toolUses = out
    .filter((m) => m.type === 'assistant' && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content)
    .filter((b) => b.type === 'tool_use')
    .map((b) => b.name);
  const toolResults = out
    .filter((m) => m.type === 'user' && Array.isArray(m.message?.content))
    .flatMap((m) => m.message.content)
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({ isError: b.is_error === true, text: (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 200) }));
  const outFile = join(other, 'out.txt');
  const summary = {
    name,
    model,
    permissionMode,
    addDir,
    initPermissionMode: init?.permissionMode ?? null,
    probeSkills: probeNames(init?.skills),
    probeCommands: probeNames(init?.slash_commands),
    toolUses,
    hookCalls: seen.hook,
    canUseToolCalls: seen.canUseTool,
    permissionDenials: (result?.permission_denials ?? []).map((d) => d.tool_name),
    toolResults,
    outFile: existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : null,
    resultSubtype: result?.subtype ?? null,
    terminalReason: result?.terminal_reason ?? null,
    reply: typeof result?.result === 'string' ? result.result.slice(0, 300) : null,
    thrown,
    stderrTail: stderr.join('').slice(-600),
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

const PONG = 'Reply with exactly: pong';
const task = (marker) =>
  `Do these steps with your tools, using absolute paths, then reply with what each returned:\n` +
  `1. Read the file ${join(other, 'notes.txt')}\n` +
  `2. Use Glob with pattern "*.txt" and path ${other}\n` +
  `3. Use Grep to search for "MAP" in ${other}\n` +
  `4. Use the Write tool to create ${join(other, 'out.txt')} containing exactly: ${marker}`;

// Today: the folder is passed as an added directory.
const today = await run('add-dir', { text: PONG, model: 'haiku', permissionMode: 'default', hook: 'allow', addDir: true });
// Proposed: not passed; OtherBench's hook allows the calls.
const plain = await run('no-add-dir-default', { text: task('written-in-default-mode'), model: 'haiku', permissionMode: 'default', hook: 'allow', addDir: false });
// Proposed, auto mode: reads allowed, the write handed to Claude Code.
const auto = await run('no-add-dir-auto', { text: task('written-in-auto-mode'), model: 'sonnet', permissionMode: 'auto', hook: 'otherbench-auto', addDir: false });

console.log('\n=== VERDICT ===');
console.log(JSON.stringify({
  addDirLoadsOtherConfig: today.probeSkills.some((s) => s.startsWith('other')) || today.probeCommands.some((s) => s.startsWith('other')),
  withoutAddDir: {
    loadsOtherConfig: [...plain.probeSkills, ...plain.probeCommands].some((s) => s.startsWith('other')),
    loadsWorkspaceConfig: [...plain.probeSkills, ...plain.probeCommands].some((s) => s.startsWith('ws')),
    defaultMode: { toolErrors: plain.toolResults.filter((t) => t.isError).length, toolResults: plain.toolResults.length, wrote: plain.outFile, canUseTool: plain.canUseToolCalls },
    autoMode: { initPermissionMode: auto.initPermissionMode, toolErrors: auto.toolResults.filter((t) => t.isError).length, toolResults: auto.toolResults.length, wrote: auto.outFile, canUseTool: auto.canUseToolCalls, denials: auto.permissionDenials },
  },
}, null, 2));
