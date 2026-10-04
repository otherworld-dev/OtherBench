import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ToolContext, ToolProvider, ToolSpec } from '../ports/tool-provider.js';
import type { ToolPolicy } from '../types/config.js';

/**
 * Shared behavioural contract for every `ToolProvider`. Run UNMODIFIED against
 * `FakeToolProvider` (packages/core/test/fakes.test.ts) and the real
 * `GruntToolProvider` (packages/tools/test/tool-provider-contract.test.ts), so
 * the fake the server tests lean on cannot drift from the real gate.
 *
 * The factory must return a provider exposing Grunt's built-in tools (fs read:
 * read-risk `source: 'fs'`; fs write: mutate-risk `source: 'fs'`; shell: a
 * `source: 'shell'` tool) and NO MCP servers. The contract discovers tools by
 * `source`/`risk`, never by name, so a fake needn't copy the real catalogue.
 *
 * Policy pinned here:
 *   - listTools(policy) is a pure function of the policy: fs 'off' offers no
 *     fs tools, 'read' only read-risk ones, 'readwrite' all; shell is offered
 *     iff `policy.shell`; mcp tools only from servers in `mcpServerIds`.
 *   - names are unique within one listing; every spec is well-formed.
 *   - refreshMcp of an unknown server and shutdown resolve; onApprovalEvent
 *     returns an unsubscribe function; resolveApproval of an unknown id is
 *     `false` (never throws); recordAgentDenial never throws.
 *   - requestApproval denies what policy forbids (or when there is no
 *     workspace) and allows a read-risk fs call under 'ask_on_mutate'.
 */
export function runToolProviderContract(
  name: string,
  factory: () => ToolProvider | Promise<ToolProvider>,
  teardown?: (provider: ToolProvider) => void | Promise<void>
): void {
  const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
    fs: 'off',
    shell: false,
    mcpServerIds: [],
    approvalMode: 'ask_on_mutate',
    ...over,
  });
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    chatId: 'chat-1',
    messageId: 'msg-1',
    profileId: 'profile-1',
    workspaceRoot: '/workspace',
    signal: new AbortController().signal,
    ...over,
  });

  describe(`ToolProvider contract: ${name}`, () => {
    let provider: ToolProvider;

    beforeEach(async () => {
      provider = await factory();
    });

    afterEach(async () => {
      if (teardown) await teardown(provider);
    });

    const names = (specs: ToolSpec[]) => specs.map((s) => s.name);

    it('offers no tools when everything is off', async () => {
      expect(await provider.listTools(policy())).toEqual([]);
    });

    it('fs "read" offers only read-risk fs tools, and at least one', async () => {
      const tools = await provider.listTools(policy({ fs: 'read' }));
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) {
        expect(t.source).toBe('fs');
        expect(t.risk).toBe('read');
      }
    });

    it('fs "readwrite" offers every read tool plus at least one mutate tool', async () => {
      const read = await provider.listTools(policy({ fs: 'read' }));
      const rw = await provider.listTools(policy({ fs: 'readwrite' }));
      expect(rw.every((t) => t.source === 'fs')).toBe(true);
      expect(rw.some((t) => t.risk === 'mutate')).toBe(true);
      for (const n of names(read)) expect(names(rw)).toContain(n);
    });

    it('shell is offered iff policy.shell, and only then', async () => {
      const on = await provider.listTools(policy({ shell: true }));
      expect(on.length).toBeGreaterThan(0);
      expect(on.every((t) => t.source === 'shell' && t.risk === 'execute')).toBe(true);
      const off = await provider.listTools(policy({ fs: 'readwrite', shell: false }));
      expect(off.some((t) => t.source === 'shell')).toBe(false);
    });

    it('combines fs and shell tools, with unique names', async () => {
      const tools = await provider.listTools(policy({ fs: 'readwrite', shell: true }));
      expect(tools.some((t) => t.source === 'fs')).toBe(true);
      expect(tools.some((t) => t.source === 'shell')).toBe(true);
      expect(new Set(names(tools)).size).toBe(tools.length);
    });

    it('every listed spec is well-formed', async () => {
      const tools = await provider.listTools(policy({ fs: 'readwrite', shell: true }));
      for (const t of tools) {
        expect(typeof t.name).toBe('string');
        expect(t.name.length).toBeGreaterThan(0);
        expect(typeof t.description).toBe('string');
        expect(t.parameters).toBeTypeOf('object');
        expect(t.parameters).not.toBeNull();
        expect(['read', 'mutate', 'execute']).toContain(t.risk);
        expect(['fs', 'shell', 'mcp', 'agent']).toContain(t.source);
        expect(typeof t.execute).toBe('function');
      }
    });

    it('naming an MCP server that is not connected contributes no tools and does not throw', async () => {
      expect(await provider.listTools(policy({ mcpServerIds: ['no-such-server'] }))).toEqual([]);
    });

    it('listTools is repeatable: the same policy yields the same tool names', async () => {
      const p = policy({ fs: 'readwrite', shell: true });
      expect(names(await provider.listTools(p))).toEqual(names(await provider.listTools(p)));
    });

    it('refreshMcp of an unknown server resolves', async () => {
      await expect(provider.refreshMcp('no-such-server')).resolves.toBeUndefined();
    });

    it('shutdown resolves', async () => {
      await expect(provider.shutdown()).resolves.toBeUndefined();
    });

    it('onApprovalEvent returns an unsubscribe function that is safe to call twice', () => {
      const off = provider.onApprovalEvent(() => {});
      expect(typeof off).toBe('function');
      off();
      expect(() => off()).not.toThrow();
    });

    it('resolveApproval of an unknown request id returns false and does not throw', () => {
      expect(provider.resolveApproval('no-such-request', { choice: 'deny' })).toBe(false);
    });

    it('recordAgentDenial never throws', () => {
      expect(() => provider.recordAgentDenial(ctx(), 'Bash', { command: 'ls' }, 'blocked')).not.toThrow();
    });

    it('requestApproval allows a read-risk fs call under ask_on_mutate with a workspace', async () => {
      const [read] = await provider.listTools(policy({ fs: 'read' }));
      expect(read).toBeDefined();
      const out = await provider.requestApproval(read as ToolSpec, {}, policy({ fs: 'read' }), ctx());
      expect(out).toMatchObject({ allowed: true });
    });

    it('requestApproval denies a call the policy forbids', async () => {
      const [shell] = await provider.listTools(policy({ shell: true }));
      expect(shell).toBeDefined();
      const out = await provider.requestApproval(shell as ToolSpec, { command: 'ls' }, policy({ shell: false }), ctx());
      expect(out).toMatchObject({ allowed: false });
      expect((out as { reason: string }).reason.length).toBeGreaterThan(0);
    });

    it('requestApproval denies an fs call when the chat has no workspace', async () => {
      const [read] = await provider.listTools(policy({ fs: 'read' }));
      const out = await provider.requestApproval(read as ToolSpec, {}, policy({ fs: 'read' }), ctx({ workspaceRoot: null }));
      expect(out).toMatchObject({ allowed: false });
    });
  });
}
