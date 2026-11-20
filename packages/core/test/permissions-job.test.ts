import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyAgentTool } from '../src/domain/agent-tools.js';
import { JOB_POLICY, jobPolicy, jobProfile, isJobProtectedPath, plantedCommandIn } from '../src/domain/job.js';
import { PermissionBroker } from '../src/domain/permissions.js';
import { toolContextFor } from '../src/domain/tool-context.js';
import type { EngineRequest } from '../src/ports/chat-engine.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import type { ResolvedProfile, ToolSource } from '../src/types/config.js';

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'otherbench-job-'));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const agent = (name: string): ToolSpec => ({ name, description: '', parameters: {}, risk: classifyAgentTool(name).risk, source: 'agent', execute: async () => undefined });
const own = (name: string, source: ToolSource, risk: ToolSpec['risk'] = 'mutate'): ToolSpec => ({ name, description: '', parameters: {}, risk, source, execute: async () => undefined });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'c1', messageId: 'm1', profileId: 'p1', workspaceRoot: ws, signal: new AbortController().signal, job: true, unattended: true, ...o });

describe('Job rules (permissions/job.ts)', () => {
  it('refuses a write to the folder\'s Claude Code settings outright, never asking or deferring', () => {
    const b = new PermissionBroker(new InMemoryStore());
    for (const [name, args] of [
      ['Write', { file_path: join(ws, '.claude', 'settings.json'), path: '.claude/settings.json' }],
      ['Edit', { file_path: join(ws, '.claude', 'settings.local.json'), path: '.claude/settings.local.json' }],
      ['Write', { file_path: join(ws, '.claude', 'private', 'notes.md'), path: '.claude/private/notes.md' }],
      ['Write', { file_path: join(ws, '.mcp.json'), path: '.mcp.json' }],
      ['Write', { file_path: join(ws, 'CLAUDE.md'), path: 'CLAUDE.md' }],
    ] as const) {
      const d = b.decide(agent(name), args, jobPolicy(), ctx());
      expect(d, `${name} ${args.path}`).toMatchObject({ kind: 'deny', job: true });
    }
  });

  it("refuses writes into .git (config, hooks, info), whatever their spelling", () => {
    const b = new PermissionBroker(new InMemoryStore());
    for (const rel of ['.git/config', '.git/hooks/pre-commit', '.git/info/attributes', '.GIT/hooks/post-checkout', '.git./config', 'sub/.git/config', '.vscode/tasks.json', '.gitmodules']) {
      const d = b.decide(agent('Write'), { file_path: join(ws, rel), path: rel }, jobPolicy(), ctx());
      expect(d, rel).toMatchObject({ kind: 'deny', job: true });
    }
  });

  it('refuses a write through a short-name segment, which could be any protected folder', () => {
    expect(isJobProtectedPath('CLAUDE~1/settings.json')).toBe(true);
    expect(isJobProtectedPath('src/index.ts')).toBe(false);
    expect(isJobProtectedPath('.github/workflows/ci.yml')).toBe(false);
  });

  it('refuses a write that resolves into .git through a link inside the folder', () => {
    mkdirSync(join(ws, '.git'));
    writeFileSync(join(ws, '.git', 'config'), '');
    // A link a sandboxed command could have made: `ln -s .git gitdir`.
    try {
      // 'junction' works without admin rights on Windows; ignored elsewhere.
      symlinkSync(join(ws, '.git'), join(ws, 'gitdir'), 'junction');
    } catch {
      return; // no links here: nothing to prove
    }
    const b = new PermissionBroker(new InMemoryStore());
    const d = b.decide(own('write_file', 'fs'), { path: 'gitdir/config', content: 'x' }, jobPolicy(), ctx());
    expect(d).toMatchObject({ kind: 'deny', job: true });
  });

  it('refuses making a file at the top of the folder named like a program started by name, for every PATHEXT extension', () => {
    const b = new PermissionBroker(new InMemoryStore());
    for (const rel of ['git.exe', 'git.com', 'git.bat', 'git.cmd', 'GIT.CMD', 'node.cmd', 'npm.ps1x', 'gh.vbs', 'where.js', 'git.wsf', 'git', 'git.exe.']) {
      const expected = rel === 'npm.ps1x' ? 'allow' : 'deny';
      expect(b.decide(agent('Write'), { file_path: join(ws, rel), path: rel }, jobPolicy(), ctx()).kind, rel).toBe(expected);
    }
    // In a subfolder it is just a file.
    expect(b.decide(agent('Write'), { file_path: join(ws, 'tools', 'git.cmd'), path: 'tools/git.cmd' }, jobPolicy(), ctx()).kind).toBe('allow');
    expect(plantedCommandIn(['src', 'README.md', 'node.vbs'])).toBe('node.vbs');
    expect(plantedCommandIn(['src', 'README.md', 'gitignore.txt'])).toBeNull();
  });

  it('allows ordinary writes in the folder by the job rule, with nobody there to ask', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(agent('Edit'), { file_path: join(ws, 'src', 'a.ts'), path: 'src/a.ts' }, jobPolicy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'job' });
    expect(b.decide(own('write_file', 'fs'), { path: 'lib/x.php', content: '' }, jobPolicy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'job' });
  });

  it('refuses a write that names no path, or a path outside the folder', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(agent('Write'), { content: 'x' }, jobPolicy(), ctx())).toMatchObject({ kind: 'deny', job: true });
    expect(b.decide(own('write_file', 'fs'), { path: '../outside.txt' }, jobPolicy(), ctx())).toMatchObject({ kind: 'deny', job: true });
  });

  it('refuses what reaches past the folder: Claude Code shell, web, MCP, SendMessage, unknown tools, and the network', () => {
    const b = new PermissionBroker(new InMemoryStore());
    for (const name of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'mcp__x__y', 'SendMessage', 'SomethingNew']) {
      expect(b.decide(agent(name), {}, jobPolicy(), ctx()).kind, name).toBe('deny');
    }
    // A sandboxed command asking for a host: refused before any grant or card, even a public one.
    expect(b.decide(own('sandbox_network', 'network', 'execute'), { host: 'github.com' }, jobPolicy(), ctx())).toMatchObject({ kind: 'deny', job: true });
    // Even a host with an always grant: grants are never consulted for a job's network.
    const store = new InMemoryStore();
    store.grants.create({ id: 'g1', profileId: 'p1', chatId: null, toolName: 'sandbox_network', source: 'network', scope: 'always', constraint: { host: 'github.com' }, expiresAt: null });
    expect(new PermissionBroker(store).decide(own('sandbox_network', 'network', 'execute'), { host: 'github.com' }, jobPolicy(), ctx())).toMatchObject({ kind: 'deny', job: true });
  });

  it('lets reads, the sandboxed run_command, the checklist and status tools through as usual', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(agent('Read'), { file_path: join(ws, 'a'), path: 'a' }, jobPolicy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'auto_read' });
    expect(b.decide(own('run_command', 'sandbox', 'execute'), { command: 'git commit -am x' }, jobPolicy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'sandbox' });
    expect(b.decide(agent('TodoWrite'), {}, jobPolicy(), ctx())).toMatchObject({ kind: 'allow' });
    expect(b.decide(own('set_chat_status', 'thread', 'read'), { done: true }, jobPolicy(), ctx())).toMatchObject({ kind: 'allow' });
  });

  it('holds the policy ceiling: everything the job policy turns off stays off', () => {
    const b = new PermissionBroker(new InMemoryStore());
    for (const [name, source] of [['recall', 'recall'], ['artifact', 'artifact'], ['message_chats', 'chats'], ['browser', 'browser'], ['computer', 'computer'], ['subagent', 'subagent'], ['run_command', 'shell']] as const) {
      expect(b.decide(own(name, source), {}, jobPolicy(), ctx()).kind, source).toBe('deny');
    }
  });

  it('is frozen, so no caller can widen it in place', () => {
    expect(Object.isFrozen(JOB_POLICY)).toBe(true);
    expect(JOB_POLICY).toMatchObject({ mcpServerIds: [], sandboxHosts: [], agentMcp: false, agentWeb: false, agentUserSettings: false, recall: false, chatMessages: false, browser: false, computer: false, shellRuns: 'sandbox', fs: 'readwrite' });
  });

  it("replaces a profile's whole tool policy, instructions and memory, keeping its model", () => {
    const profile = {
      id: 'p1',
      name: 'Wide open',
      modelId: 'opus',
      connectionId: 'cc',
      systemPrompt: 'do anything',
      useGlobalMemory: true,
      browserAllowedSites: ['example.com'],
      params: {},
      toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: ['gh'], approvalMode: 'ask_on_mutate', browser: true, sandboxHosts: ['github.com'] },
    } as unknown as ResolvedProfile;
    const job = jobProfile(profile);
    expect(job.toolPolicy).toEqual(jobPolicy());
    expect(job).toMatchObject({ modelId: 'opus', systemPrompt: null, useGlobalMemory: false, browserAllowedSites: [] });
  });

  it('is carried from the request to every tool context, and turns the schedule-style auto flag off', () => {
    const req = { chatId: 'c', messageId: 'm', profile: { id: 'p' }, workspaceRoot: ws, signal: new AbortController().signal, unattended: true, autoMode: true, job: true } as unknown as EngineRequest;
    const c = toolContextFor(req);
    expect(c.job).toBe(true);
    expect(c.unattendedAuto).toBeUndefined();
  });
});
