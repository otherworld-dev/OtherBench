// Live probe for job chats, fix 1: the worst case. NOT part of CI.
// Usage (after `npm run build`):
//   node packages/engine-claude-code/scripts/probe-planted-startup.mjs <dir with marker.exe> <mode> [model]
// <mode>: `job` (a job's own options), `no-env` (the same, without
// NoDefaultCurrentDirectoryInExePath and CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS),
// or `plain` (an ordinary folder chat's options). The options are built first
// on a clean folder, as OtherBench's engine builds them (its guard passes),
// then stand-ins are planted (the gap between the guard and the spawn), then
// Claude Code starts and answers one message. Any marker is a program Windows
// ran from the folder in place of the real one.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { processOptions } from '../dist/process-options.js';
import { jobPolicy } from '@otherbench/core/domain/job.js';

const dir = resolve(process.argv[2] ?? '');
const mode = process.argv[3] ?? 'job';
const model = process.argv[4] ?? 'haiku';
const marker = join(dir, 'marker.exe');
if (!existsSync(marker)) throw new Error(`no marker.exe in ${dir}`);
const run = `start-${mode}-${Date.now()}`;
const markers = join(dir, `${run}-markers`);
const ws = join(dir, `${run}-job`);
const noHooks = join(dir, `${run}-nohooks`);
for (const d of [markers, ws, noHooks]) mkdirSync(d, { recursive: true });
writeFileSync(join(dir, 'markers-dir.txt'), markers);
execFileSync('git', ['init', '-q', '-b', 'jobs/probe', ws]);
writeFileSync(join(ws, 'README.md'), '# probe\n');
execFileSync('git', ['-C', ws, '-c', 'user.name=p', '-c', 'user.email=p@p', 'add', '.']);
execFileSync('git', ['-C', ws, '-c', 'user.name=p', '-c', 'user.email=p@p', 'commit', '-q', '-m', 'init']);
// An uncommitted change, so a git status has something to look at.
writeFileSync(join(ws, 'README.md'), '# probe\nchanged\n');

const conn = { id: 'c', name: 'CC', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null };
const policy = mode === 'plain' ? { fs: 'readwrite', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' } : jobPolicy();
const req = {
  profile: { id: 'p', name: 'Probe', description: null, colour: null, connectionId: 'c', modelId: model, systemPrompt: null, params: {}, toolPolicy: policy, isDefault: false, archivedAt: null, connection: conn, apiKey: null, model: null },
  messages: [],
  tools: [],
  signal: new AbortController().signal,
  chatId: 'probe',
  messageId: 'm1',
  workspaceRoot: ws,
  ...(mode === 'plain' ? {} : { job: true, unattended: true }),
};
const options = processOptions({ query, approvals: {}, listEndpointModels: async () => [], jobNoHooksDir: () => noHooks }, req, ws, false, false);
if (mode === 'no-env') {
  delete options.env.NoDefaultCurrentDirectoryInExePath;
  delete options.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS;
}

for (const name of ['git', 'gh', 'node', 'npm', 'npx', 'rg', 'where', 'which', 'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'wsl', 'reg', 'findstr', 'cygpath', 'uname', 'git-lfs', 'ssh', 'code', 'claude', 'tasklist', 'wmic', 'whoami', 'hostname', 'chcp']) {
  copyFileSync(marker, join(ws, `${name}.exe`));
  copyFileSync(marker, join(ws, `${name}.com`));
  const script = `@echo %~f0 %* ^| %CD% > "${markers}\\%~nx0.%RANDOM%.txt"\r\n@exit /b 1\r\n`;
  writeFileSync(join(ws, `${name}.bat`), script);
  writeFileSync(join(ws, `${name}.cmd`), script);
}

// Controls. Node's own spawn (libuv) of a bare `git` with the folder as working folder, with and without the variable.
const { spawnSync } = await import('node:child_process');
for (const env of [{ ...process.env }, { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' }]) {
  const r = spawnSync('git', ['--version'], { cwd: ws, env, encoding: 'utf8' });
  console.log(`control: node spawn('git') in the folder${env.NoDefaultCurrentDirectoryInExePath ? ' with NoDefaultCurrentDirectoryInExePath' : ''}: exit ${r.status}, says ${JSON.stringify((r.stdout || '').trim())}`);
}
// And whether Claude Code starts the real git at all: git writes a trace of every run here.
const trace = join(dir, `${run}-git-trace.txt`);
options.env.GIT_TRACE2 = trace;

let text = '';
async function* input() {
  yield { type: 'user', message: { role: 'user', content: 'Reply with the single word OK.' }, parent_tool_use_id: null };
}
for await (const m of query({ prompt: input(), options: { ...options, maxTurns: 1 } })) {
  if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'text') text += b.text;
  if (m.type === 'result') break;
}
await new Promise((r) => setTimeout(r, 3000));
const fired = readdirSync(markers);
const traced = existsSync(trace) ? readFileSync(trace, 'utf8').split(/\r?\n/).filter((l) => / start /.test(l)).map((l) => l.replace(/^.* start /, '').trim()) : [];
console.log(`real git runs Claude Code made: ${traced.length === 0 ? 'none' : traced.join(' | ')}`);
console.log(`mode ${mode}: reply ${JSON.stringify(text.trim().slice(0, 40))}; markers: ${fired.length === 0 ? 'none' : fired.length}`);
for (const f of fired) console.log(`  ${f}: ${readFileSync(join(markers, f), 'utf8').replace(/\s+/g, ' ').trim()}`);
