// Smoke test for the bundled server (v2 plan, Task 40): starts
// dist-bundle/server/cli.js the way the desktop app does (`--port 0
// --announce`, token in OTHERBENCH_TOKEN) against a scratch database, then
// checks health, that terminals are available, a mock-provider turn, search, a .docx, an .xlsx and a .pptx
// made by the bundled writers, a claude.ai export read by the bundled reader, and that the packages left
// out of the bundle load.
// Exits non-zero on any failure.
//
// `npm run bundle:smoke -w @otherbench/server`, after `npm run bundle`. Pass a
// server folder to test another copy (the one a desktop build carries), and
// run it with that build's node to test the pair.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(process.argv[2] ?? join(serverDir, 'dist-bundle', 'server'), 'cli.js');
const dir = mkdtempSync(join(tmpdir(), 'otherbench-bundle-smoke-'));
const token = randomBytes(32).toString('hex');

const child = spawn(process.execPath, [bundle, 'serve', '--port', '0', '--announce', '--db', join(dir, 'otherbench.db')], {
  // No Cowork folder: the import check reads only the export it writes.
  env: { ...process.env, OTHERBENCH_TOKEN: token, OTHERBENCH_COWORK_ROOT: '' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

function fail(message) {
  console.error(`[smoke] FAIL: ${message}`);
  child.kill();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the killed server's database open; the scratch folder is in the temp dir.
  }
  process.exit(1);
}

const timer = setTimeout(() => fail('timed out'), 60_000);

const port = await new Promise((resolve, reject) => {
  const lines = createInterface({ input: child.stdout });
  lines.once('line', (line) => resolve(JSON.parse(line).port));
  child.once('exit', (code) => reject(new Error(`server exited (${code}) before announcing`)));
}).catch((err) => fail(err.message));

const base = `http://127.0.0.1:${port}/api`;
async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) fail(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const health = await api('GET', '/health');
console.log(`[smoke] up on ${port} (${health.platform})`);

// The Code tab's terminals (spec 2026-10-21-code-terminal-design): node-pty and its prebuilt binary are copied beside
// cli.js, and a missing one only turns terminals off, so check here that the bundle really has them.
const terminal = await api('GET', '/terminal/status');
if (!terminal.available) fail(`the bundled server has no terminal (${terminal.reason})`);
// Available on Windows only proves the binary loads, so start one: a shell in an app's folder, then close it.
const terminalApp = await api('POST', '/apps', { name: 'Smoke', workspacePath: dir });
const shell = await api('POST', `/apps/${terminalApp.id}/terminals`, { cols: 80, rows: 24 });
await api('DELETE', `/apps/${terminalApp.id}/terminals/${shell.id}`);
console.log(`[smoke] a terminal started and closed (${terminal.shells.map((s) => s.id).join(', ')})`);

const connection = await api('POST', '/connections', { name: 'Mock', kind: 'mock' });
const profile = await api('POST', '/profiles', { name: 'Mock', connectionId: connection.id, modelId: 'mock-standard', isDefault: true });
const chat = await api('POST', '/chats', { profileId: profile.id });
const turn = await api('POST', `/chats/${chat.id}/turns`, { parentId: null, parts: [{ type: 'text', text: 'bundled hello' }], profileIds: [profile.id] });
const replyId = turn.assistantMessageIds[0];
for (let i = 0; ; i++) {
  const { messages } = await api('GET', `/chats/${chat.id}/messages`);
  const reply = messages.find((m) => m.id === replyId);
  if (reply?.status === 'complete') break;
  if (reply?.status === 'error' || i > 100) fail(`the mock reply ended ${reply?.status ?? 'missing'}`);
  await new Promise((r) => setTimeout(r, 100));
}
console.log('[smoke] mock turn completed');

const hits = await api('GET', '/search?q=bundled');
if (!Array.isArray(hits) || hits.length === 0) fail('search found nothing');
console.log('[smoke] search found the message');

// Office files (spec 2026-10-12-office-files §6): the mock makes one of each
// kind through the real artifact tool, and the bundled writers make the file.
// The worker must sit beside cli.js: render.ts also looks in ../../dist, which
// would hide a bundle that lacks it when this runs from the repo.
if (!existsSync(join(dirname(bundle), 'render-worker.js'))) fail('render-worker.js is missing beside cli.js');
async function officeFile(kind, mainPart) {
  const officeChat = await api('POST', '/chats', { profileId: profile.id });
  const made = await api('POST', `/chats/${officeChat.id}/turns`, { parentId: null, parts: [{ type: 'text', text: `#office ${kind}` }], profileIds: [profile.id] });
  const officeReplyId = made.assistantMessageIds[0];
  let result;
  for (let i = 0; ; i++) {
    const { messages } = await api('GET', `/chats/${officeChat.id}/messages`);
    const reply = messages.find((m) => m.id === officeReplyId);
    if (reply?.status === 'complete') {
      result = reply.parts.find((p) => p.type === 'tool-result');
      break;
    }
    if (reply?.status === 'error' || i > 100) fail(`the #office ${kind} reply ended ${reply?.status ?? 'missing'}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!result || result.isError) fail(`#office ${kind} made no artifact: ${JSON.stringify(result)}`);
  const { artifactId, versionId } = JSON.parse(result.result);
  const res = await fetch(`${base}/chats/${officeChat.id}/artifacts/${artifactId}/versions/${versionId}/file`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) fail(`the ${kind} file: ${res.status} ${await res.text()}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50 || !bytes.includes(mainPart)) fail(`the ${kind} file isn't an Office file (no ${mainPart} in it)`);
}
await officeFile('document', 'word/document.xml');
await officeFile('spreadsheet', 'xl/workbook.xml');
await officeFile('presentation', 'ppt/presentation.xml');
console.log('[smoke] the bundled writers made a .docx, an .xlsx and a .pptx');

// A claude.ai export is read in a worker (src/import/claude-reader.ts), which must also sit beside cli.js.
if (!existsSync(join(dirname(bundle), 'claude-reader-worker.js'))) fail('claude-reader-worker.js is missing beside cli.js');
const exportDir = join(dir, 'claude-export');
mkdirSync(exportDir);
writeFileSync(join(exportDir, 'conversations.json'), JSON.stringify([{ uuid: '9b0c1a52-0d8e-4c0e-9d6f-2f1e8f2b7a10', name: 'Smoke', chat_messages: [{ uuid: 'm1', sender: 'human', text: 'hello', content: [{ type: 'text', text: 'hello' }] }] }]));
const preview = await api('POST', '/import/claude/preview', { folder: exportDir });
if (preview.chats?.total !== 1) fail(`the import preview read ${JSON.stringify(preview.chats)} from a one-chat export`);
writeFileSync(join(exportDir, 'conversations.json'), '{ broken');
const refused = await fetch(`${base}/import/claude/preview`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: exportDir }) });
const refusal = await refused.text();
if (refused.status !== 400 || !refusal.includes("isn't valid JSON")) fail(`a broken export answered ${refused.status} ${refusal}`);
console.log('[smoke] the bundled export reader read an export and refused a broken one');

// The packages left out of the bundle, loaded from beside it.
for (const pkg of ['unpdf', '@anthropic-ai/claude-agent-sdk']) {
  const check = spawn(process.execPath, ['--input-type=module', '-e', `await import('${pkg}')`], { cwd: dirname(bundle), stdio: 'inherit' });
  const code = await new Promise((r) => check.once('exit', r));
  if (code !== 0) fail(`${pkg} doesn't load from the bundle`);
}
console.log('[smoke] unpdf and the Claude Agent SDK load');

child.stdin.end();
await new Promise((r) => child.once('exit', r));
clearTimeout(timer);
rmSync(dir, { recursive: true, force: true });
console.log('[smoke] ok');
