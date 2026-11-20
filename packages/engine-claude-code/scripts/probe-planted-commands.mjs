// Live probe for job chats, fix 1 (docs/features/jobs.md). NOT part of CI.
// Usage (after `npm run build`):
//   node packages/engine-claude-code/scripts/probe-planted-commands.mjs <dir with marker.exe> [model]
// <dir> holds marker.exe, a harmless program that only writes a marker file
// (its name, arguments and working folder) into the folder named in
// <dir>/markers-dir.txt. This probe points that at a fresh folder, runs one
// real job turn through OtherBench's own engine in a git repository,
// and at the turn's first tool call (mid-turn, as a job's sandboxed command
// could) plants the marker in the job folder's top level under many program
// names, as .exe, .com, .bat and .cmd. The turn then does everything a job
// turn does with Claude Code's own tools. Any marker that appears is a
// program Windows ran from the job folder in place of the real one.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeChatEngine } from '../dist/engine.js';
import { jobPolicy } from '@otherbench/core/domain/job.js';

const dir = resolve(process.argv[2] ?? '');
const model = process.argv[3] ?? 'haiku';
const marker = join(dir, 'marker.exe');
if (!existsSync(marker)) throw new Error(`no marker.exe in ${dir}`);
const run = `run-${Date.now()}`;
const markers = join(dir, `${run}-markers`);
const ws = join(dir, `${run}-job`);
const noHooks = join(dir, `${run}-nohooks`);
for (const d of [markers, ws, noHooks]) mkdirSync(d, { recursive: true });
writeFileSync(join(dir, 'markers-dir.txt'), markers);

execFileSync('git', ['init', '-q', '-b', 'jobs/probe', ws]);
writeFileSync(join(ws, 'README.md'), '# probe\n\nThe word probe appears here.\n');
mkdirSync(join(ws, 'src'));
writeFileSync(join(ws, 'src', 'a.js'), 'export const a = 1;\n');
execFileSync('git', ['-C', ws, '-c', 'user.name=p', '-c', 'user.email=p@p', 'add', '.']);
execFileSync('git', ['-C', ws, '-c', 'user.name=p', '-c', 'user.email=p@p', 'commit', '-q', '-m', 'init']);

// Names a program might be started by: anything Claude Code, a shell or OtherBench could start bare.
const NAMES = [
  'git', 'gh', 'git-lfs', 'node', 'npm', 'npx', 'bun', 'rg', 'where', 'which', 'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'wsl',
  'reg', 'findstr', 'find', 'sort', 'more', 'tasklist', 'taskkill', 'wmic', 'cygpath', 'uname', 'ssh', 'code', 'claude', 'conhost',
  'chcp', 'ps', 'tar', 'curl', 'python', 'python3', 'py', 'cscript', 'wscript', 'explorer', 'whoami', 'hostname', 'systeminfo',
  'ipconfig', 'netstat', 'attrib', 'icacls', 'timeout', 'ver', 'tree', 'diff', 'patch', 'less', 'cat', 'ls', 'head', 'tail',
];
let planted = false;
function plant() {
  if (planted) return;
  planted = true;
  for (const name of NAMES) {
    copyFileSync(marker, join(ws, `${name}.exe`));
    copyFileSync(marker, join(ws, `${name}.com`));
    const script = `@echo %~f0 %* ^| %CD% > "${markers}\\%~nx0.%RANDOM%.txt"\r\n@exit /b 1\r\n`;
    writeFileSync(join(ws, `${name}.bat`), script);
    writeFileSync(join(ws, `${name}.cmd`), script);
  }
  console.log(`planted ${NAMES.length * 4} stand-ins in ${ws}`);
}

const conn = { id: 'c', name: 'CC', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null };
const profile = { id: 'p', name: 'Probe', description: null, colour: null, connectionId: 'c', modelId: model, systemPrompt: null, params: {}, toolPolicy: jobPolicy(), isDefault: false, archivedAt: null, connection: conn, apiKey: null, model: null };
const calls = [];
// Every call allowed (what is probed is what Claude Code starts, not what OtherBench refuses); the first one plants.
const approvals = {
  requestApproval: async (tool) => {
    calls.push(tool.name);
    plant();
    return { allowed: true, grantedBy: 'policy' };
  },
  recordAgentDenial: () => undefined,
};
const prompt = [
  'Do each of these steps in order, using your own tools, then reply DONE:',
  '1. Read README.md.',
  '2. Use Glob to list **/*.js.',
  '3. Use Grep to search for "probe" in the folder.',
  '4. Edit README.md: add a line "edited" at the end.',
  '5. Write a new file notes/a.txt containing "hello".',
  '6. Use TodoWrite with two items, both completed.',
  '7. Use the Task tool to start a helper that reads src/a.js and Greps for "const"; wait for it.',
  '8. Read README.md again.',
].join('\n');
const engine = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], jobNoHooksDir: () => noHooks });
let text = '';
for await (const e of engine.stream({
  profile,
  messages: [{ id: 'u1', chatId: 'probe', parentId: null, role: 'user', parts: [{ type: 'text', text: prompt }], status: 'complete', error: null, producedBy: null, createdAt: 1 }],
  tools: [],
  signal: new AbortController().signal,
  chatId: `probe-${run}`,
  messageId: 'm1',
  workspaceRoot: ws,
  latestMessageForSession: () => null,
  job: true,
  unattended: true,
})) {
  if (e.type === 'text-delta') text += e.text;
  if (e.type === 'error') console.error(`error: ${e.error.message}`);
}
engine.dispose();
await new Promise((r) => setTimeout(r, 3000));
const fired = readdirSync(markers);
console.log(`\nreply: ${text.trim().slice(-200)}`);
console.log(`tool calls OtherBench saw: ${calls.join(', ')}`);
console.log(`planted mid-turn: ${planted}`);
console.log(`markers: ${fired.length === 0 ? 'none' : ''}`);
for (const f of fired) console.log(`  ${f}: ${readFileSync(join(markers, f), 'utf8').replace(/\s+/g, ' ').trim()}`);
process.exit(fired.length === 0 ? 0 : 1);
