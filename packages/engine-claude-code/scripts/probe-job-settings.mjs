// Live probe for job chats, step 1 (docs/features/jobs.md). NOT part of CI.
// Usage (after `npm run build`): node packages/engine-claude-code/scripts/probe-job-settings.mjs <scratch-dir> [model]
// Uses the Claude login: two short turns through OtherBench's own engine, in a
// folder that is a git repository with things planted the way a job's sandboxed
// commands could plant them:
//   - .claude/settings.json and .claude/settings.local.json with SessionStart,
//     UserPromptSubmit and Stop hooks (they would run on this machine with no card);
//   - .git/config with core.fsmonitor set (Claude Code's own git status at
//     startup would run it) and a post-checkout and reference-transaction hook.
// Each plant writes a marker file. The control turn is an ordinary folder
// chat; the job turn is the same folder as a job. Expected: the control
// fires the settings hooks, the job fires nothing.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeChatEngine } from '../dist/engine.js';
import { jobPolicy } from '@otherbench/core/domain/job.js';

const scratch = process.argv[2];
const model = process.argv[3] ?? 'haiku';
if (!scratch) throw new Error('pass a scratch directory outside any git repository');
{
  let probe = resolve(scratch);
  while (!existsSync(probe)) probe = dirname(probe);
  let top = null;
  try {
    top = execFileSync('git', ['-C', probe, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* not in a repository: good */
  }
  if (top) {
    console.error(`Refusing to run: ${scratch} is inside a git repository (${top}).`);
    process.exit(2);
  }
}

const root = resolve(scratch);
rmSync(root, { recursive: true, force: true });
const markers = join(root, 'markers');
const noHooks = join(root, 'no-git-hooks');
mkdirSync(markers, { recursive: true });
mkdirSync(noHooks, { recursive: true });
const mark = (name) => `node -e "require('fs').writeFileSync('${join(markers, name).replace(/\\/g, '/')}','x')"`;

function makeFolder(name) {
  const ws = join(root, name);
  mkdirSync(join(ws, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', ws]);
  writeFileSync(join(ws, 'README.md'), 'probe\n');
  execFileSync('git', ['-C', ws, '-c', 'user.name=p', '-c', 'user.email=p@p', 'add', '.']);
  execFileSync('git', ['-C', ws, '-c', 'user.name=p', '-c', 'user.email=p@p', 'commit', '-q', '-m', 'init']);
  const hooks = (tag) => ({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: mark(`${name}-${tag}-SessionStart`) }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: mark(`${name}-${tag}-UserPromptSubmit`) }] }],
      Stop: [{ hooks: [{ type: 'command', command: mark(`${name}-${tag}-Stop`) }] }],
    },
  });
  writeFileSync(join(ws, '.claude', 'settings.json'), JSON.stringify(hooks('settings'), null, 2));
  writeFileSync(join(ws, '.claude', 'settings.local.json'), JSON.stringify(hooks('local'), null, 2));
  // Planted after the commit, as a sandboxed command could: Claude Code's own git on this machine must not run these.
  execFileSync('git', ['-C', ws, 'config', 'core.fsmonitor', mark(`${name}-git-fsmonitor`)]);
  for (const hook of ['post-checkout', 'reference-transaction', 'post-index-change']) {
    writeFileSync(join(ws, '.git', 'hooks', hook), `#!/bin/sh\n${mark(`${name}-git-${hook}`)}\n`);
  }
  return ws;
}

const conn = { id: 'c', name: 'CC', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null };
const profile = (toolPolicy) => ({ id: 'p', name: 'Probe', description: null, colour: null, connectionId: 'c', modelId: model, systemPrompt: null, params: {}, toolPolicy, isDefault: false, archivedAt: null, connection: conn, apiKey: null, model: null });
// Every call allowed: what is being probed is what runs without asking anyone.
const approvals = { requestApproval: async () => ({ allowed: true, grantedBy: 'policy' }), recordAgentDenial: () => undefined };

async function turn(ws, job) {
  const engine = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], jobNoHooksDir: () => noHooks });
  const req = {
    profile: profile(job ? jobPolicy() : { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' }),
    messages: [{ id: 'u1', chatId: 'probe', parentId: null, role: 'user', parts: [{ type: 'text', text: 'Reply with the single word OK. Do not use any tools.' }], status: 'complete', error: null, producedBy: null, createdAt: 1 }],
    tools: [],
    signal: new AbortController().signal,
    chatId: `probe-${job ? 'job' : 'control'}`,
    messageId: 'm1',
    workspaceRoot: ws,
    latestMessageForSession: () => null,
    ...(job ? { job: true, unattended: true } : {}),
  };
  let text = '';
  for await (const e of engine.stream(req)) {
    if (e.type === 'text-delta') text += e.text;
    if (e.type === 'error') console.error(`  error: ${e.error.message}`);
  }
  engine.dispose();
  // Stop hooks run as the process ends.
  await new Promise((r) => setTimeout(r, 3000));
  return text.trim();
}

const control = makeFolder('control');
const job = makeFolder('job');
console.log(`control turn says: ${await turn(control, false)}`);
console.log(`job turn says:     ${await turn(job, true)}`);
const fired = readdirSync(markers).sort();
const controlFired = fired.filter((m) => m.startsWith('control-'));
const jobFired = fired.filter((m) => m.startsWith('job-'));
console.log(`\ncontrol fired: ${controlFired.join(', ') || 'nothing'}`);
console.log(`job fired:     ${jobFired.join(', ') || 'nothing'}`);
const controlSettings = controlFired.some((m) => m.includes('-settings-') || m.includes('-local-'));
console.log(`\n${controlSettings ? 'OK' : 'INCONCLUSIVE'}: the ordinary folder chat ${controlSettings ? 'ran' : 'did NOT run'} the planted settings hooks (the control).`);
console.log(`${jobFired.length === 0 ? 'OK' : 'FAIL'}: the job ran ${jobFired.length === 0 ? 'none of them' : jobFired.join(', ')}.`);
process.exit(jobFired.length === 0 && controlSettings ? 0 : 1);
