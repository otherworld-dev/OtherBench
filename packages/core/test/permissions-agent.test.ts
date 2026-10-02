import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PermissionBroker } from '../src/domain/permissions.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import type { ToolPolicy } from '../src/types/config.js';
import { classifyAgentTool } from '../src/domain/agent-tools.js';

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'grunt-agent-')); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const spec = (name: string): ToolSpec => ({ name, description: '', parameters: {}, risk: classifyAgentTool(name).risk, source: 'agent', execute: async () => undefined });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'c1', messageId: 'm1', profileId: 'p1', workspaceRoot: ws, signal: new AbortController().signal, ...o });
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate', ...o });

describe('PermissionBroker with source "agent"', () => {
  it('denies every agent tool without a workspace', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(spec('Read'), { path: 'a' }, policy(), ctx({ workspaceRoot: null })).kind).toBe('deny');
  });
  it('auto-allows read tools under ask_on_mutate, asks under always_ask', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(spec('Read'), { path: 'a' }, policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'auto_read' });
    expect(b.decide(spec('Read'), { path: 'a' }, policy({ approvalMode: 'always_ask' }), ctx()).kind).toBe('ask');
  });
  it('allows internal tools without asking, in either mode', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(spec('TodoWrite'), {}, policy({ approvalMode: 'always_ask' }), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'policy' });
  });
  it('asks for Edit and Bash, and applies the policy ceiling', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(spec('Edit'), { path: 'a.ts' }, policy(), ctx()).kind).toBe('ask');
    expect(b.decide(spec('Bash'), { command: 'ls' }, policy(), ctx()).kind).toBe('ask');
    expect(b.decide(spec('Bash'), { command: 'ls' }, policy({ shell: false }), ctx()).kind).toBe('deny');
    expect(b.decide(spec('Edit'), { path: 'a.ts' }, policy({ fs: 'read' }), ctx()).kind).toBe('deny');
  });
  it('pins a chat grant for agent Bash to the exact command', () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    const d = b.decide(spec('Bash'), { command: 'npm test' }, policy(), ctx());
    if (d.kind !== 'ask') throw new Error('expected ask');
    b.resolve(d.request.id, { choice: 'chat' });
    expect(store.grants.list()[0]).toMatchObject({ source: 'agent', toolName: 'Bash', constraint: { commandExact: 'npm test' } });
    expect(b.decide(spec('Bash'), { command: 'npm test' }, policy(), ctx()).kind).toBe('allow');
    expect(b.decide(spec('Bash'), { command: 'npm test && rm -rf /' }, policy(), ctx()).kind).toBe('ask');
  });
  it('refuses an unconstrained always grant for agent Bash', () => {
    const b = new PermissionBroker(new InMemoryStore());
    const d = b.decide(spec('Bash'), { command: 'ls' }, policy(), ctx());
    if (d.kind !== 'ask') throw new Error('expected ask');
    expect(() => b.resolve(d.request.id, { choice: 'always', constraint: null })).toThrow(/unconstrained/);
  });
  it('never lets an agent grant satisfy a Grunt fs tool of the same name, or vice versa', () => {
    const store = new InMemoryStore();
    store.grants.create({ id: 'g1', chatId: 'c1', profileId: 'p1', toolName: 'Edit', source: 'agent', scope: 'chat', constraint: null, expiresAt: null });
    const b = new PermissionBroker(store);
    const fsSpec: ToolSpec = { ...spec('Edit'), source: 'fs' };
    expect(b.decide(fsSpec, { path: 'a.ts' }, policy(), ctx()).kind).toBe('ask');
  });

  it('treats PowerShell as shell: pinned chat grant, no unconstrained always, ceiling', () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    expect(b.decide(spec('PowerShell'), { command: 'dir' }, policy({ shell: false }), ctx()).kind).toBe('deny');
    const d = b.decide(spec('PowerShell'), { command: 'dir' }, policy(), ctx());
    if (d.kind !== 'ask') throw new Error('expected ask');
    expect(() => b.resolve(d.request.id, { choice: 'always', constraint: null })).toThrow(/unconstrained/);
    const d2 = b.decide(spec('PowerShell'), { command: 'dir' }, policy(), ctx());
    if (d2.kind !== 'ask') throw new Error('expected ask');
    b.resolve(d2.request.id, { choice: 'chat' });
    expect(store.grants.list()[0]).toMatchObject({ toolName: 'PowerShell', constraint: { commandExact: 'dir' } });
  });
  it('auto_read is name-based: mis-declared risk still asks', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide({ ...spec('Bash'), risk: 'read' }, { command: 'ls' }, policy(), ctx()).kind).toBe('ask');
    expect(b.decide({ ...spec('Edit'), risk: 'read' }, { path: 'a' }, policy(), ctx()).kind).toBe('ask');
  });
  it('allows EnterPlanMode/ToolSearch/Skill as internal', () => {
    const b = new PermissionBroker(new InMemoryStore());
    for (const n of ['EnterPlanMode', 'ToolSearch', 'Skill']) {
      expect(b.decide(spec(n), {}, policy({ approvalMode: 'always_ask' }), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'policy' });
    }
  });
  it('denies MCP resource tools under agentMcp:false', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(spec('ListMcpResourcesTool'), {}, policy({ agentMcp: false }), ctx()).kind).toBe('deny');
  });
  it('unknown agent tools can only be approved once', () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    for (const choice of ['chat', 'always'] as const) {
      const d = b.decide(spec('CronCreate'), { a: 1 }, policy(), ctx());
      if (d.kind !== 'ask') throw new Error('expected ask');
      b.resolve(d.request.id, choice === 'chat' ? { choice } : { choice, constraint: null });
      expect(store.grants.list()).toHaveLength(0);
    }
    expect(b.decide(spec('CronCreate'), { a: 1 }, policy(), ctx()).kind).toBe('ask');
  });
  it('denies Edit and Bash without a workspace', () => {
    const b = new PermissionBroker(new InMemoryStore());
    for (const n of ['Edit', 'Bash']) expect(b.decide(spec(n), {}, policy(), ctx({ workspaceRoot: null })).kind).toBe('deny');
  });
  describe('writes to Claude Code config (R13)', () => {
    const protectedPaths = [
      '.claude/settings.local.json', '.claude/skills/x/SKILL.md', '.mcp.json', 'CLAUDE.md', 'docs/CLAUDE.local.md',
      // Windows 8.3 short names for the same files.
      'CLAUDE~1/settings.local.json', 'CLAUDE~1.MD', 'MCP~1.JSO',
    ];

    it.each(protectedPaths)('a chat or always answer for %s stores no grant, and the next write asks again', (path) => {
      const store = new InMemoryStore();
      const b = new PermissionBroker(store);
      for (const choice of ['chat', 'always'] as const) {
        const d = b.decide(spec('Write'), { path }, policy(), ctx());
        if (d.kind !== 'ask') throw new Error('expected ask');
        b.resolve(d.request.id, choice === 'chat' ? { choice } : { choice, constraint: { pathPrefix: path } });
      }
      expect(store.grants.list()).toHaveLength(0);
      expect(b.decide(spec('Write'), { path }, policy(), ctx()).kind).toBe('ask');
    });

    it('existing grants never cover a protected write, even unconstrained or with a covering pathPrefix', () => {
      const store = new InMemoryStore();
      store.grants.create({ id: 'g-chat', chatId: 'c1', profileId: 'p1', toolName: 'Edit', source: 'agent', scope: 'chat', constraint: null, expiresAt: null });
      store.grants.create({ id: 'g-always', chatId: null, profileId: 'p1', toolName: 'Edit', source: 'agent', scope: 'always', constraint: { pathPrefix: '.' }, expiresAt: null });
      const b = new PermissionBroker(store);
      expect(b.decide(spec('Edit'), { path: 'src/a.ts' }, policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
      for (const path of protectedPaths) expect(b.decide(spec('Edit'), { path }, policy(), ctx()).kind).toBe('ask');
      expect(b.decide(spec('Edit'), { path: '.claude/settings.local.json' }, policy({ approvalMode: 'always_ask' }), ctx()).kind).toBe('ask');
    });

    it('an agent file write with no path cannot be checked, so no grant covers it', () => {
      const store = new InMemoryStore();
      store.grants.create({ id: 'g', chatId: 'c1', profileId: 'p1', toolName: 'Write', source: 'agent', scope: 'chat', constraint: null, expiresAt: null });
      const b = new PermissionBroker(store);
      expect(b.decide(spec('Write'), { content: 'x' }, policy(), ctx()).kind).toBe('ask');
    });

    it('still allows reading Claude Code config without a card under ask_on_mutate', () => {
      const b = new PermissionBroker(new InMemoryStore());
      expect(b.decide(spec('Read'), { path: '.claude/settings.json' }, policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'auto_read' });
    });

    it('still stores chat grants for ordinary paths', () => {
      const store = new InMemoryStore();
      const b = new PermissionBroker(store);
      const d = b.decide(spec('Write'), { path: 'src/a.ts' }, policy(), ctx());
      if (d.kind !== 'ask') throw new Error('expected ask');
      b.resolve(d.request.id, { choice: 'chat' });
      expect(store.grants.list()).toHaveLength(1);
    });
  });

  it('an fs-source grant does not satisfy an agent call of the same name', () => {
    const store = new InMemoryStore();
    store.grants.create({ id: 'g2', chatId: 'c1', profileId: 'p1', toolName: 'Edit', source: 'fs', scope: 'chat', constraint: null, expiresAt: null });
    const b = new PermissionBroker(store);
    expect(b.decide(spec('Edit'), { path: 'a.ts' }, policy(), ctx()).kind).toBe('ask');
  });
});
