// The sandbox through Grunt itself, on this Windows machine (spec
// 2026-10-12-sandbox-design §6, "Live"): starts the built server on a scratch
// database, sets the sandbox up through the API (the repair path when the
// distro exists), then runs a real run_command from an API (mock) profile and,
// if Claude Code is logged in here, from a Claude Code chat (one short haiku turn).
//
// `node packages/server/scripts/sandbox-live.mjs`, after `npm run build`. Exits non-zero on any failure.
// GRUNT_SANDBOX_LIVE_CLAUDE=0 skips the Claude Code part (it spends a turn of the Claude login).

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'grunt-sandbox-live-'));
const workspace = mkdtempSync(join(tmpdir(), 'grunt-sandbox-live-ws-'));
const token = randomBytes(32).toString('hex');

const child = spawn(process.execPath, [join(serverDir, 'dist', 'cli.js'), 'serve', '--port', '0', '--announce', '--db', join(dir, 'grunt.db')], {
  env: { ...process.env, GRUNT_TOKEN: token },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const exited = new Promise((resolve) => child.once('exit', resolve));

class Failure extends Error {}
const fail = (message) => {
  throw new Failure(message);
};
const log = (line) => console.log(`[sandbox-live] ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isSandboxResult = (r) => (typeof r === 'string' ? r : JSON.stringify(r)).includes('"sandbox":true');
/** run_command as the API engine names it, or as Claude Code calls the relayed one (`mcp__grunt_<hex>__run_command`). */
const isRunCommand = (name) => name === 'run_command' || /^mcp__grunt_[0-9a-f]+__run_command$/.test(name);

let port;
async function api(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) fail(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function reply(chatId, text, profileId, timeoutMs) {
  const turn = await api('POST', `/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text }], profileIds: [profileId] });
  const id = turn.assistantMessageIds[0];
  for (const started = Date.now(); Date.now() - started < timeoutMs; await sleep(500)) {
    const { messages } = await api('GET', `/chats/${chatId}/messages`);
    const message = messages.find((m) => m.id === id);
    if (message?.status === 'complete') return message;
    if (message?.status === 'error') fail(`the reply ended in an error: ${JSON.stringify(message.error)}`);
  }
  fail('the reply never finished');
}

async function main() {
  port = await new Promise((resolve, reject) => {
    createInterface({ input: child.stdout }).once('line', (line) => resolve(JSON.parse(line).port));
    child.once('exit', (code) => reject(new Failure(`server exited (${code}) before announcing`)));
  });

  // 1. Set up (or repair) through the API, as Settings > Sandbox does.
  await api('POST', '/sandbox/setup');
  let status;
  // A ready status carries no log, so the last one seen while setting up is kept to show the self-test.
  let progress = [];
  for (const started = Date.now(); ; await sleep(2000)) {
    status = await api('GET', '/sandbox');
    if (status.state !== 'setting_up') break;
    progress = status.log ?? progress;
    if (Date.now() - started > 60 * 60_000) fail('setup took more than an hour');
  }
  if (status.state !== 'ready') fail(`setup ended ${status.state}: ${status.detail}\n${(status.log ?? []).join('\n')}`);
  log(`setup, as far as it was seen:\n${progress.join('\n')}`);
  log(`ready: ${JSON.stringify(status.versions)}`);

  // 2. An API (mock) profile's run_command, with no card under ask on mutate.
  const mockConn = await api('POST', '/connections', { name: 'Mock', kind: 'mock' });
  const policy = { fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'ask_on_mutate' };
  const mock = await api('POST', '/profiles', { name: 'Sandboxed mock', connectionId: mockConn.id, modelId: 'mock-standard', toolPolicy: policy });
  const chat = await api('POST', '/chats', { title: 'Sandbox live', profileId: mock.id, workspaceRoot: workspace });
  const mockReply = await reply(chat.id, '#run uname -s && echo made-by-grunt > grunt-live.txt', mock.id, 5 * 60_000);
  const mockResult = mockReply.parts.find((p) => p.type === 'tool-result');
  if (!mockResult || !isSandboxResult(mockResult.result)) fail(`no sandboxed result: ${JSON.stringify(mockReply.parts)}`);
  if (!JSON.stringify(mockResult.result).includes('Linux')) fail(`uname didn't say Linux: ${JSON.stringify(mockResult.result)}`);
  const written = join(workspace, 'grunt-live.txt');
  if (!existsSync(written) || readFileSync(written, 'utf8') !== 'made-by-grunt\n') fail('the file the command wrote is not in the workspace');
  log(`API profile: run_command ran in the sandbox: ${mockResult.result}`);

  // 3. A Claude Code chat's run_command, through Grunt's relay, when Claude Code is logged in here.
  // It spends a turn of the Claude login: GRUNT_SANDBOX_LIVE_CLAUDE=0 leaves it out.
  if (process.env.GRUNT_SANDBOX_LIVE_CLAUDE === '0') {
    log('SKIPPED Claude Code: GRUNT_SANDBOX_LIVE_CLAUDE=0');
    return;
  }
  const ccConn = await api('POST', '/connections', { name: 'Claude Code', kind: 'claude_code' });
  const test = await api('POST', `/connections/${ccConn.id}/test`);
  if (!test.ok) {
    log(`SKIPPED Claude Code: ${test.message}`);
    return;
  }
  const cc = await api('POST', '/profiles', { name: 'Sandboxed Claude Code', connectionId: ccConn.id, modelId: 'haiku', toolPolicy: policy });
  const ccChat = await api('POST', '/chats', { title: 'Sandbox live (Claude Code)', profileId: cc.id, workspaceRoot: workspace });
  const ccReply = await reply(ccChat.id, 'Use the run_command tool to run `uname -s`, then reply with exactly what it printed and nothing else.', cc.id, 10 * 60_000);
  const call = ccReply.parts.find((p) => p.type === 'tool-call' && isRunCommand(p.name));
  const result = ccReply.parts.find((p) => p.type === 'tool-result' && isRunCommand(p.name));
  if (!call || !result || !isSandboxResult(result.result)) fail(`Claude Code didn't run run_command in the sandbox: ${JSON.stringify(ccReply.parts)}`);
  if (ccReply.parts.some((p) => p.type === 'tool-call' && p.name === 'Bash')) fail('Claude Code used Bash under the sandbox');
  const said = ccReply.parts.filter((p) => p.type === 'text').map((p) => p.text).join('').trim();
  log(`Claude Code: ${call.name} ran in the sandbox: ${typeof result.result === 'string' ? result.result : JSON.stringify(result.result)}; it replied ${JSON.stringify(said)}`);
}

const report = (err) => log(`FAIL: ${err instanceof Failure ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
let code = 0;
try {
  await main();
} catch (err) {
  code = 1;
  report(err);
}
// Closing stdin stops an --announce server, which closes the sandbox's agents and unmounts its folders before it exits.
child.stdin.end();
await Promise.race([exited, sleep(30_000)]);
if (child.exitCode === null) {
  child.kill();
  if (code === 0) report(new Failure("the server didn't exit within 30 s of its stdin closing"));
  code = 1;
}
// Grunt unmounts the workspace as it stops, if that finishes within its shutdown wait (cli.ts SHUTDOWN_WAIT_MS);
// otherwise WSL drops the mount when it stops the idle distro. Said, not failed: wsl.exe can be slow on a busy machine.
const linux = `/mnt/${realpathSync.native(workspace).replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).replace(/\\/g, '/')}`;
const wslExe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
const mounts = spawnSync(wslExe, ['-d', 'grunt-sandbox', '-u', 'root', '--exec', '/usr/bin/findmnt', '-l', '-n', '-o', 'TARGET'], { encoding: 'utf8' });
const stillMounted = mounts.stdout.split(/\r?\n/).some((line) => line.trim() === linux);
log(stillMounted ? `${linux} was still mounted after Grunt stopped: waiting for WSL to stop the distro` : 'Grunt unmounted the workspace as it stopped');
for (const folder of [dir, workspace]) {
  try {
    // A folder still mounted in the VM can't be deleted on Windows (EPERM) until the mount goes: up to a minute.
    rmSync(folder, { recursive: true, force: true, maxRetries: 30, retryDelay: 2000 });
  } catch (err) {
    if (code === 0) report(new Failure(`couldn't remove ${folder}: ${err.message}`));
    code = 1;
  }
}
if (code === 0) log('ok');
process.exit(code);
