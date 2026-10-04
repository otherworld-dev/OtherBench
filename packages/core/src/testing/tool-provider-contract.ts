import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ApprovalChoice, ToolApprovalEvent, ToolContext, ToolProvider, ToolSpec } from '../ports/tool-provider.js';
import type { ToolPolicy } from '../types/config.js';

/** An MCP server the contract needs the provider under test to expose as connected. */
export interface ContractMcpServer {
  id: string;
  name: string;
  tools: { name: string; readOnly: boolean }[];
}

export interface ToolProviderContractSetup {
  mcpServers: ContractMcpServer[];
}

const MCP_SERVERS: ContractMcpServer[] = [
  { id: 'srv-a', name: 'alpha', tools: [{ name: 'lookup', readOnly: true }, { name: 'change', readOnly: false }] },
  // Same display name and tool name on two servers: namespacing collides, de-dup must suffix.
  { id: 'srv-b', name: 'dup', tools: [{ name: 't', readOnly: true }] },
  { id: 'srv-c', name: 'dup', tools: [{ name: 't', readOnly: true }] },
];

/**
 * Shared behavioural contract for every `ToolProvider`. Run UNMODIFIED against
 * `FakeToolProvider` (packages/core/test/fakes.test.ts) and the real
 * `GruntToolProvider` (packages/tools/test/tool-provider-contract.test.ts), so
 * the fake the server tests lean on cannot drift from the real gate.
 *
 * The factory is handed the MCP servers the contract needs (`ToolProviderContractSetup`)
 * and must return a provider that exposes exactly those as connected MCP servers, plus
 * Grunt's built-in tools (named `read_file`, `write_file`, `run_command`; fs read:
 * read-risk `source: 'fs'`; fs write: mutate-risk `source: 'fs'`; shell: a
 * `source: 'shell'` tool). Listing assertions discover tools by `source`/`risk`;
 * the execution assertions use those three names with real arguments against a real
 * temp workspace, so the real provider genuinely runs them.
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
 *   - EXECUTION goes through the gate: a listed tool's execute() returns a
 *     tool-error `{error:true, code}` (never throws) when denied by policy
 *     ('permission_denied') or by the user / an abort ('approval_denied'), and
 *     runs when allowed or approved. Applies to fs, shell and mcp tools; Claude
 *     Code ('agent') tools go through requestApproval with the same outcomes.
 *   - ask raises a 'request' event, resolveApproval answers it (true once, false
 *     after), then a 'resolved' event carries the choice; read-risk fs/mcp
 *     tools under ask_on_mutate never ask; a 'chat' grant suppresses a repeat ask.
 *   - deferAsk turns an ask for a deferrable agent tool into {deferred:true}, and
 *     never softens a denial or an ask for a non-deferrable tool.
 *   - colliding tool names are de-duplicated with a numeric suffix.
 */
export function runToolProviderContract(
  name: string,
  factory: (setup: ToolProviderContractSetup) => ToolProvider | Promise<ToolProvider>,
  teardown?: (provider: ToolProvider) => void | Promise<void>
): void {
  const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
    fs: 'off',
    shell: false,
    mcpServerIds: [],
    approvalMode: 'ask_on_mutate',
    ...over,
  });
  let ws = '/workspace';
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    chatId: 'chat-1',
    messageId: 'msg-1',
    profileId: 'profile-1',
    workspaceRoot: ws,
    signal: new AbortController().signal,
    ...over,
  });

  describe(`ToolProvider contract: ${name}`, () => {
    let provider: ToolProvider;

    beforeEach(async () => {
      ws = await mkdtemp(join(tmpdir(), 'grunt-tp-contract-'));
      await writeFile(join(ws, 'contract.txt'), 'hello from the contract\n');
      provider = await factory({ mcpServers: MCP_SERVERS });
    });

    afterEach(async () => {
      if (teardown) await teardown(provider);
      await rm(ws, { recursive: true, force: true });
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
    // -----------------------------------------------------------------------
    // Execution through the gate
    // -----------------------------------------------------------------------

    const isToolError = (r: unknown, code?: string): boolean =>
      typeof r === 'object' && r !== null && (r as { error?: unknown }).error === true && (code === undefined || (r as { code?: unknown }).code === code);

    /** Collects approval events; `answer` (if set) resolves each request as soon as it is raised. */
    function watch(answer?: ApprovalChoice): { events: ToolApprovalEvent[]; requests: Extract<ToolApprovalEvent, { type: 'request' }>[] } {
      const events: ToolApprovalEvent[] = [];
      const requests: Extract<ToolApprovalEvent, { type: 'request' }>[] = [];
      provider.onApprovalEvent((e) => {
        events.push(e);
        if (e.type === 'request') {
          requests.push(e);
          if (answer) expect(provider.resolveApproval(e.request.id, answer)).toBe(true);
        }
      });
      return { events, requests };
    }

    async function tool(p: ToolPolicy, toolName: string): Promise<ToolSpec> {
      const found = (await provider.listTools(p)).find((t) => t.name === toolName);
      if (!found) throw new Error(`expected "${toolName}" to be listed`);
      return found;
    }

    const READ_ARGS = { path: 'contract.txt' };
    const WRITE_ARGS = { path: 'out.txt', content: 'written by the contract' };
    const SHELL_ARGS = { command: 'echo contract' };

    it('fs read tool under ask_on_mutate runs without asking', async () => {
      const w = watch();
      const t = await tool(policy({ fs: 'read' }), 'read_file');
      expect(isToolError(await t.execute(READ_ARGS, ctx()))).toBe(false);
      expect(w.requests).toHaveLength(0);
    });

    it('executing a listed fs or shell tool with no workspace returns permission_denied and never asks', async () => {
      const w = watch();
      for (const [p, n, args] of [
        [policy({ fs: 'read' }), 'read_file', READ_ARGS],
        [policy({ fs: 'readwrite' }), 'write_file', WRITE_ARGS],
        [policy({ shell: true }), 'run_command', SHELL_ARGS],
      ] as const) {
        const t = await tool(p, n);
        expect(isToolError(await t.execute(args, ctx({ workspaceRoot: null })), 'permission_denied')).toBe(true);
      }
      expect(w.requests).toHaveLength(0);
    });

    it('fs read tool under always_ask raises a request; approving runs it and emits resolved', async () => {
      const w = watch({ choice: 'once' });
      const t = await tool(policy({ fs: 'read', approvalMode: 'always_ask' }), 'read_file');
      expect(isToolError(await t.execute(READ_ARGS, ctx()))).toBe(false);
      expect(w.requests).toHaveLength(1);
      expect(w.requests[0]?.request).toMatchObject({ toolName: 'read_file', source: 'fs', risk: 'read', chatId: 'chat-1', messageId: 'msg-1' });
      expect(w.events.map((e) => e.type)).toEqual(['request', 'resolved']);
      expect(w.events[1]).toMatchObject({ type: 'resolved', requestId: w.requests[0]?.request.id, messageId: 'msg-1', choice: 'once' });
    });

    it('fs write tool asks under ask_on_mutate; deny returns approval_denied, approve runs', async () => {
      const t = await tool(policy({ fs: 'readwrite' }), 'write_file');
      const deny = watch({ choice: 'deny' });
      expect(isToolError(await t.execute(WRITE_ARGS, ctx()), 'approval_denied')).toBe(true);
      expect(deny.requests).toHaveLength(1);
      expect(deny.events[1]).toMatchObject({ type: 'resolved', choice: 'deny' });
    });

    it('fs write tool approved runs and returns a non-error result', async () => {
      const w = watch({ choice: 'once' });
      const t = await tool(policy({ fs: 'readwrite' }), 'write_file');
      expect(isToolError(await t.execute(WRITE_ARGS, ctx()))).toBe(false);
      expect(w.requests).toHaveLength(1);
    });

    it('shell tool always asks; approve runs, deny returns approval_denied', async () => {
      const t = await tool(policy({ shell: true }), 'run_command');
      const approve = watch({ choice: 'once' });
      expect(isToolError(await t.execute(SHELL_ARGS, ctx()))).toBe(false);
      expect(approve.requests[0]?.request).toMatchObject({ toolName: 'run_command', source: 'shell', risk: 'execute' });

    });

    it('shell deny returns approval_denied', async () => {
      const w = watch({ choice: 'deny' });
      const t = await tool(policy({ shell: true }), 'run_command');
      expect(isToolError(await t.execute(SHELL_ARGS, ctx()), 'approval_denied')).toBe(true);
      expect(w.requests).toHaveLength(1);
    });

    it('a request can be answered later (not only synchronously); resolveApproval is true once then false', async () => {
      const w = watch();
      const t = await tool(policy({ shell: true }), 'run_command');
      const running = t.execute(SHELL_ARGS, ctx());
      await new Promise((r) => setTimeout(r, 5));
      expect(w.requests).toHaveLength(1);
      const id = (w.requests[0] as { request: { id: string } }).request.id;
      expect(provider.resolveApproval(id, { choice: 'once' })).toBe(true);
      expect(isToolError(await running)).toBe(false);
      expect(provider.resolveApproval(id, { choice: 'once' })).toBe(false);
    });

    it('aborting the turn while a request is pending refuses it as cancelled, not as the user denying it', async () => {
      const w = watch();
      const t = await tool(policy({ shell: true }), 'run_command');
      const ac = new AbortController();
      const running = t.execute(SHELL_ARGS, ctx({ signal: ac.signal }));
      await new Promise((r) => setTimeout(r, 5));
      expect(w.requests).toHaveLength(1);
      ac.abort();
      expect(isToolError(await running, 'cancelled')).toBe(true);
      expect(w.events.at(-1)).toMatchObject({ type: 'resolved', choice: 'deny' });
    });

    it('a call on a turn that already ended is refused as cancelled, raising no card, even when policy allows it', async () => {
      const w = watch({ choice: 'once' });
      const ac = new AbortController();
      ac.abort();
      const asking = await tool(policy({ shell: true }), 'run_command');
      expect(isToolError(await asking.execute(SHELL_ARGS, ctx({ signal: ac.signal })), 'cancelled')).toBe(true);
      expect(w.requests).toHaveLength(0);
      const allowed = await tool(policy({ fs: 'readwrite' }), 'read_file');
      expect(isToolError(await allowed.execute(READ_ARGS, ctx({ signal: ac.signal })), 'cancelled')).toBe(true);
    });

    it('a listener that throws does not break the gate', async () => {
      provider.onApprovalEvent(() => {
        throw new Error('listener boom');
      });
      watch({ choice: 'once' });
      const t = await tool(policy({ shell: true }), 'run_command');
      expect(isToolError(await t.execute(SHELL_ARGS, ctx()))).toBe(false);
    });

    it('a chat-scope approval is remembered: the same call does not ask again', async () => {
      const w = watch({ choice: 'chat' });
      const t = await tool(policy({ fs: 'readwrite' }), 'write_file');
      expect(isToolError(await t.execute(WRITE_ARGS, ctx()))).toBe(false);
      expect(isToolError(await t.execute(WRITE_ARGS, ctx()))).toBe(false);
      expect(w.requests).toHaveLength(1);
    });

    it('an unsubscribed listener stops receiving events', async () => {
      const seen: string[] = [];
      const off = provider.onApprovalEvent((e) => seen.push(e.type));
      off();
      watch({ choice: 'once' });
      const t = await tool(policy({ shell: true }), 'run_command');
      await t.execute(SHELL_ARGS, ctx());
      expect(seen).toEqual([]);
    });

    // ---- MCP ----

    it('MCP tools are offered only for enabled servers, tagged with their serverId', async () => {
      const tools = await provider.listTools(policy({ mcpServerIds: ['srv-a'] }));
      expect(tools).toHaveLength(2);
      for (const t of tools) {
        expect(t.source).toBe('mcp');
        expect(t.serverId).toBe('srv-a');
      }
      expect(tools.map((t) => t.risk).sort()).toEqual(['mutate', 'read']);
      expect(await provider.listTools(policy({ mcpServerIds: ['srv-b'] }))).toHaveLength(1);
    });

    it('a read-risk MCP tool under ask_on_mutate runs without asking; a mutate-risk one asks', async () => {
      const w = watch({ choice: 'once' });
      const tools = await provider.listTools(policy({ mcpServerIds: ['srv-a'] }));
      const read = tools.find((t) => t.risk === 'read') as ToolSpec;
      const mutate = tools.find((t) => t.risk === 'mutate') as ToolSpec;
      expect(isToolError(await read.execute({}, ctx()))).toBe(false);
      expect(w.requests).toHaveLength(0);
      expect(isToolError(await mutate.execute({}, ctx()))).toBe(false);
      expect(w.requests).toHaveLength(1);
      expect(w.requests[0]?.request).toMatchObject({ source: 'mcp', risk: 'mutate' });
    });

    it('a mutate-risk MCP tool denied by the user returns approval_denied; under always_ask even a read-risk one asks', async () => {
      const w = watch({ choice: 'deny' });
      const tools = await provider.listTools(policy({ mcpServerIds: ['srv-a'], approvalMode: 'always_ask' }));
      for (const t of tools) expect(isToolError(await t.execute({}, ctx()), 'approval_denied')).toBe(true);
      expect(w.requests).toHaveLength(2);
    });

    it('requestApproval for an MCP tool: allowed when read-risk, denied when its server is not enabled', async () => {
      const tools = await provider.listTools(policy({ mcpServerIds: ['srv-a'] }));
      const read = tools.find((t) => t.risk === 'read') as ToolSpec;
      expect(await provider.requestApproval(read, {}, policy({ mcpServerIds: ['srv-a'] }), ctx())).toMatchObject({ allowed: true });
      expect(await provider.requestApproval(read, {}, policy({ mcpServerIds: ['srv-b'] }), ctx())).toMatchObject({ allowed: false });
      expect(await provider.requestApproval(read, {}, policy({ mcpServerIds: [] }), ctx())).toMatchObject({ allowed: false });
    });

    it('colliding tool names are de-duplicated with a numeric suffix, in order, and each still executes its own tool', async () => {
      const tools = await provider.listTools(policy({ mcpServerIds: ['srv-b', 'srv-c'] }));
      expect(tools).toHaveLength(2);
      const [first, second] = names(tools) as [string, string];
      expect(second).toBe(`${first}_2`);
      expect(tools.map((t) => t.serverId)).toEqual(['srv-b', 'srv-c']);
      for (const t of tools) expect(isToolError(await t.execute({}, ctx()))).toBe(false);
    });

    // ---- requestApproval across sources (fs / shell / mcp / agent) ----

    const agent = (toolName: string, risk: ToolSpec['risk']): ToolSpec => ({
      name: toolName,
      description: '',
      parameters: {},
      risk,
      source: 'agent',
      execute: async () => {
        throw new Error('agent tools are executed by Claude Code, never by the provider');
      },
    });

    it('requestApproval denies each source when policy forbids it, without raising a request', async () => {
      const w = watch();
      const [write] = (await provider.listTools(policy({ fs: 'readwrite' }))).filter((t) => t.risk === 'mutate');
      const [shell] = await provider.listTools(policy({ shell: true }));
      expect(await provider.requestApproval(write as ToolSpec, WRITE_ARGS, policy({ fs: 'read' }), ctx())).toMatchObject({ allowed: false });
      expect(await provider.requestApproval(shell as ToolSpec, SHELL_ARGS, policy({ shell: false }), ctx())).toMatchObject({ allowed: false });
      expect(await provider.requestApproval(agent('Bash', 'execute'), { command: 'ls' }, policy({ shell: false }), ctx())).toMatchObject({ allowed: false });
      expect(await provider.requestApproval(agent('Edit', 'mutate'), { path: 'a.txt' }, policy({ fs: 'read' }), ctx())).toMatchObject({ allowed: false });
      expect(await provider.requestApproval(agent('WebFetch', 'mutate'), {}, policy({ agentWeb: false }), ctx())).toMatchObject({ allowed: false });
      expect(await provider.requestApproval(agent('mcp__x__y', 'mutate'), {}, policy({ agentMcp: false }), ctx())).toMatchObject({ allowed: false });
      expect(w.requests).toHaveLength(0);
    });

    it('agent tools: a file read is auto-allowed under ask_on_mutate; a workspace is required', async () => {
      expect(await provider.requestApproval(agent('Read', 'read'), { path: 'a.txt' }, policy({ fs: 'read' }), ctx())).toMatchObject({ allowed: true });
      expect(await provider.requestApproval(agent('Read', 'read'), { path: 'a.txt' }, policy({ fs: 'read' }), ctx({ workspaceRoot: null }))).toMatchObject({ allowed: false });
    });

    it('agent tools: shell asks; approve allows, deny reports the user denial', async () => {
      const approve = watch({ choice: 'once' });
      const out = await provider.requestApproval(agent('Bash', 'execute'), { command: 'npm test' }, policy({ shell: true }), ctx());
      expect(out).toMatchObject({ allowed: true, grantedBy: 'ask:once' });
      expect(approve.requests[0]?.request).toMatchObject({ source: 'agent', toolName: 'Bash' });
    });

    it('agent tools: user denial reports allowed:false with the reason', async () => {
      watch({ choice: 'deny' });
      expect(await provider.requestApproval(agent('Bash', 'execute'), { command: 'ls' }, policy({ shell: true }), ctx())).toEqual({
        allowed: false,
        reason: 'The user denied this tool call.',
      });
    });

    it('deferAsk hands a deferrable agent tool to auto mode: {deferred:true}, no request raised', async () => {
      const w = watch();
      const out = await provider.requestApproval(agent('Bash', 'execute'), { command: 'npm test' }, policy({ shell: true }), ctx(), { deferAsk: true });
      expect(out).toEqual({ deferred: true });
      expect(w.requests).toHaveLength(0);
    });

    it('deferAsk never softens a denial, and never defers an allow', async () => {
      expect(await provider.requestApproval(agent('Bash', 'execute'), { command: 'ls' }, policy({ shell: false }), ctx(), { deferAsk: true })).toMatchObject({ allowed: false });
      expect(await provider.requestApproval(agent('Read', 'read'), { path: 'a.txt' }, policy({ fs: 'read' }), ctx(), { deferAsk: true })).toMatchObject({ allowed: true });
    });

    it('deferAsk does not defer an agent tool it cannot classify, or a protected config write: those still ask', async () => {
      const w = watch({ choice: 'once' });
      expect(await provider.requestApproval(agent('SomeNewTool', 'mutate'), {}, policy(), ctx(), { deferAsk: true })).toMatchObject({ allowed: true, grantedBy: 'ask:once' });
      expect(await provider.requestApproval(agent('Write', 'mutate'), { path: '.claude/settings.json' }, policy({ fs: 'readwrite' }), ctx(), { deferAsk: true })).toMatchObject({ allowed: true, grantedBy: 'ask:once' });
      expect(w.requests).toHaveLength(2);
    });

    it('deferAsk does not defer fs, shell or mcp tools: those still ask', async () => {
      const w = watch({ choice: 'once' });
      const [shell] = await provider.listTools(policy({ shell: true }));
      expect(await provider.requestApproval(shell as ToolSpec, SHELL_ARGS, policy({ shell: true }), ctx(), { deferAsk: true })).toMatchObject({ allowed: true, grantedBy: 'ask:once' });
      expect(w.requests).toHaveLength(1);
    });
  });
}
