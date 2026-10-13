// Entry point of Grunt's sandbox agent (spec 2026-10-12-sandbox-design §2):
// wires agent-core.mjs to the real sandbox runtime and to this process's
// stdin/stdout. Grunt starts it in the distro as the grunt user:
//   wsl.exe -d grunt-sandbox -u grunt --exec /opt/grunt-sandbox/node/bin/node /opt/grunt-sandbox/agent.mjs
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  // For the protected files the agent puts back: never through a link at the path itself.
  readFile: (path) => readFile(path),
  // A new file only (the old one was removed first): never through a link, never into a hard-linked file.
  createFile: (path, data, mode) => writeFile(path, data, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode }),
  chmod: (path, mode) => chmod(path, mode),
  readdir: (path) => readdir(path),
  readlink: (path) => readlink(path),
  symlink: (target, path) => symlink(target, path),
  // The runtime guards the protected files of its own working folder, so the agent moves into the command's while it wraps it.
  chdir: (path) => process.chdir(path),
  cwd: () => process.cwd(),
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
