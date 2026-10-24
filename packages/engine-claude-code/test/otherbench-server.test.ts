import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import { otherBenchArtifactTool, otherBenchMcpServer, otherBenchPlanTool, otherBenchRecallTool, otherBenchServerName, otherBenchToolName, type OtherBenchServerTool } from '../src/otherbench-server.js';
import { relayServerTool } from '../src/relay.js';

/** A real MCP client connected to OtherBench's server over an in-memory link, as Claude Code talks to it. */
async function connect(tools: OtherBenchServerTool[]): Promise<Client> {
  const config = otherBenchMcpServer('otherbench_test', tools);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe("OtherBench's own tools for Claude Code", () => {
  it('passes the call to the running reply and returns its outcome as JSON, flagging errors', async () => {
    const run = vi.fn(async (args: unknown) => ({ ok: true, echoed: args }));
    const def = otherBenchArtifactTool(() => run);
    expect(def.name).toBe('artifact');
    const ok = await def.call({ command: 'view', id: 'calc' });
    expect(run).toHaveBeenCalledWith({ command: 'view', id: 'calc' });
    expect(ok).toEqual({ content: [{ type: 'text', text: JSON.stringify({ ok: true, echoed: { command: 'view', id: 'calc' } }) }], isError: false });

    const failing = otherBenchArtifactTool(() => async () => ({ error: true, code: 'unknown_id', message: 'No artifact "x".' }));
    expect((await failing.call({ command: 'view', id: 'x' })).isError).toBe(true);
  });

  it('offers live as a string in the artifact tool schema (spec 2026-10-12-live-artifacts)', () => {
    const def = otherBenchArtifactTool(() => undefined);
    expect((def.inputSchema.properties as Record<string, { type?: string }>)['live']).toMatchObject({ type: 'string' });
  });

  it('refuses when no OtherBench reply is running or artifacts are off', async () => {
    const result = await otherBenchArtifactTool(() => undefined).call({ command: 'view', id: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Artifacts are turned off for this profile, or no OtherBench reply is running.');
  });

  it('offers recall on the same server: the call goes to the running reply, and is refused when none is running or recall is off', async () => {
    const run = vi.fn(async (args: unknown) => ({ chats: [], projects: [], echoed: args }));
    const def = otherBenchRecallTool(() => run);
    expect(def.name).toBe('recall');
    const ok = await def.call({ command: 'search', query: 'hetzner' });
    expect(run).toHaveBeenCalledWith({ command: 'search', query: 'hetzner' });
    expect(ok.isError).toBe(false);

    const off = await otherBenchRecallTool(() => undefined).call({ command: 'search', query: 'x' });
    expect(off.isError).toBe(true);
    expect(JSON.stringify(off.content)).toContain('Searching past chats is turned off for this profile, or no OtherBench reply is running.');
  });

  it("names each process's server afresh, so a project's MCP config can't take the name", () => {
    const names = new Set(Array.from({ length: 20 }, () => otherBenchServerName()));
    expect(names.size).toBe(20);
    for (const name of names) expect(name).toMatch(/^otherbench_[0-9a-f]{16}$/);
  });
});

describe("OtherBench's MCP server, on raw handlers", () => {
  it('lists every tool with its JSON input schema, always loaded', async () => {
    const client = await connect([otherBenchArtifactTool(() => undefined), otherBenchRecallTool(() => undefined)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['artifact', 'recall']);
    const artifact = tools[0]!;
    expect(artifact.inputSchema.type).toBe('object');
    expect((artifact.inputSchema.properties as Record<string, { enum?: string[] }>)['command']!.enum).toContain('view');
    for (const t of tools) expect(t._meta).toEqual({ 'anthropic/alwaysLoad': true });
  });

  it("leaves a relayed MCP tool to tool search, so a big server costs nothing until it's used, and keeps the browser loaded", async () => {
    const relayed = (name: string, source: ToolSpec['source']): ToolSpec => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} }, risk: 'read', source, execute: async () => null });
    const client = await connect([
      otherBenchArtifactTool(() => undefined),
      relayServerTool('nextcloud__deck_list', relayed('mcp__nextcloud__deck_list', 'mcp'), () => undefined),
      relayServerTool('browser', relayed('browser', 'browser'), () => undefined),
    ]);
    const { tools } = await client.listTools();
    const meta = Object.fromEntries(tools.map((t) => [t.name, t._meta ?? null]));
    expect(meta).toEqual({ artifact: { 'anthropic/alwaysLoad': true }, nextcloud__deck_list: null, browser: { 'anthropic/alwaysLoad': true } });
  });

  it('runs a call on the named tool and returns its result', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const client = await connect([otherBenchArtifactTool(() => run)]);
    const result = await client.callTool({ name: 'artifact', arguments: { command: 'view', id: 'calc' } });
    expect(run).toHaveBeenCalledWith({ command: 'view', id: 'calc' });
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
  });

  it("hands a call Claude Code's tool-use id when the request carries one, and the request's signal", async () => {
    const seen: { toolUseId?: string; signal?: AbortSignal }[] = [];
    const tool: OtherBenchServerTool = {
      name: 'generate_image',
      description: 'Generate an image',
      inputSchema: { type: 'object', properties: {} },
      alwaysLoad: true,
      call: async (_args, opts) => {
        seen.push(opts ?? {});
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const client = await connect([tool]);
    await client.callTool({ name: 'generate_image', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_01' } });
    await client.callTool({ name: 'generate_image', arguments: {} });
    await client.callTool({ name: 'generate_image', arguments: {}, _meta: { 'claudecode/toolUseId': 7 } });
    expect(seen.map((s) => s.toolUseId)).toEqual(['toolu_01', undefined, undefined]);
    for (const s of seen) expect(s.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives a tool call six hours, so a long generation is not cut off at the default timeout', () => {
    expect(otherBenchMcpServer('otherbench_test', []).timeout).toBe(6 * 60 * 60 * 1000);
  });

  it('answers an unknown tool, or a call that throws, as an error result rather than failing the request', async () => {
    const throwing: OtherBenchServerTool = {
      name: 'boom',
      description: 'Always throws',
      inputSchema: { type: 'object', properties: {} },
      call: async () => {
        throw new Error('server went away');
      },
    };
    const client = await connect([throwing]);
    const unknown = await client.callTool({ name: 'nope', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain('nope');
    const thrown = await client.callTool({ name: 'boom', arguments: {} });
    expect(thrown.isError).toBe(true);
    expect(JSON.stringify(thrown.content)).toContain('server went away');
  });
});

describe("OtherBench's plan tool for Claude Code", () => {
  it("names each tool on the process's server", () => {
    expect(otherBenchToolName('otherbench_ab', 'propose_plan')).toBe('mcp__otherbench_ab__propose_plan');
  });
  it("passes the plan to the running reply and answers with the runner's text, not JSON", async () => {
    const run = vi.fn(async (_args: unknown) => 'The user approved the plan. Go ahead with it; tools that change things still need their usual approvals.');
    const def = otherBenchPlanTool(() => run);
    expect(def.name).toBe('propose_plan');
    expect(await def.call({ plan: '1. x' })).toEqual({ content: [{ type: 'text', text: 'The user approved the plan. Go ahead with it; tools that change things still need their usual approvals.' }], isError: false });
    expect(run).toHaveBeenCalledWith({ plan: '1. x' });
  });
  it('flags a tool error, and refuses when no reply is planning', async () => {
    const bad = await otherBenchPlanTool(() => async () => ({ error: true, code: 'invalid_input', message: '"plan" must be your plan, in Markdown.' })).call({});
    expect(bad).toEqual({ content: [{ type: 'text', text: '"plan" must be your plan, in Markdown.' }], isError: true });
    expect((await otherBenchPlanTool(() => undefined).call({ plan: 'x' })).isError).toBe(true);
  });
});
