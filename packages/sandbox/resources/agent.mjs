// Entry point of Grunt's sandbox agent (spec 2026-10-12-sandbox-design §2):
// wires agent-core.mjs to the real sandbox runtime and to this process's
// stdin/stdout. Grunt starts it in the distro as the grunt user:
//   wsl.exe -d grunt-sandbox -u grunt --exec /opt/grunt-sandbox/node/bin/node /opt/grunt-sandbox/agent.mjs
import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { createInterface } from 'node:readline';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createAgent } from './agent-core.mjs';

const agent = createAgent({
  runtime: SandboxManager,
  spawn,
  send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
  mkdir,
  rm,
  lstat,
  realpath,
  // stdout is the protocol; notes about skipped clean-ups go to stderr.
  warn: (message) => process.stderr.write(`${message}\n`),
  kill: (pid, signal) => process.kill(pid, signal),
  exit: (code) => process.exit(code),
  // The core sets TMPDIR and CLAUDE_CODE_TMPDIR here, which the runtime reads.
  env: process.env,
  // Every address a name resolves to, for the early refusal of private destinations.
  lookup: (host) => lookup(host, { all: true }),
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  void agent.receive(line);
});
// Grunt went away or closed us: stop every command and the runtime's proxies.
lines.on('close', () => {
  void agent.receive(JSON.stringify({ type: 'close' }));
});
