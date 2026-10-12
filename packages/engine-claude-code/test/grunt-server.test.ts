import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { gruntArtifactTool, gruntMcpServer, gruntPlanTool, gruntRecallTool, gruntServerName, gruntToolName, type GruntServerTool } from '../src/grunt-server.js';

/** A real MCP client connected to Grunt's server over an in-memory link, as Claude Code talks to it. */
async function connect(tools: GruntServerTool[]): Promise<Client> {
  const config = gruntMcpServer('grunt_test', tools);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe("Grunt's own tools for Claude Code", () => {
  it('passes the call to the running reply and returns its outcome as JSON, flagging errors', async () => {
    const run = vi.fn(async (args: unknown) => ({ ok: true, echoed: args }));
    const def = gruntArtifactTool(() => run);
    expect(def.name).toBe('artifact');
    const ok = await def.call({ command: 'view', id: 'calc' });
    expect(run).toHaveBeenCalledWith({ command: 'view', id: 'calc' });
    expect(ok).toEqual({ content: [{ type: 'text', text: JSON.stringify({ ok: true, echoed: { command: 'view', id: 'calc' } }) }], isError: false });

    const failing = gruntArtifactTool(() => async () => ({ error: true, code: 'unknown_id', message: 'No artifact "x".' }));
    expect((await failing.call({ command: 'view', id: 'x' })).isError).toBe(true);
  });

  it('refuses when no Grunt reply is running or artifacts are off', async () => {
    const result = await gruntArtifactTool(() => undefined).call({ command: 'view', id: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Artifacts are turned off for this profile, or no Grunt reply is running.');
  });

  it('offers recall on the same server: the call goes to the running reply, and is refused when none is running or recall is off', async () => {
    const run = vi.fn(async (args: unknown) => ({ chats: [], projects: [], echoed: args }));
    const def = gruntRecallTool(() => run);
    expect(def.name).toBe('recall');
    const ok = await def.call({ command: 'search', query: 'hetzner' });
    expect(run).toHaveBeenCalledWith({ command: 'search', query: 'hetzner' });
    expect(ok.isError).toBe(false);

    const off = await gruntRecallTool(() => undefined).call({ command: 'search', query: 'x' });
    expect(off.isError).toBe(true);
    expect(JSON.stringify(off.content)).toContain('Searching past chats is turned off for this profile, or no Grunt reply is running.');
  });

  it("names each process's server afresh, so a project's MCP config can't take the name", () => {
    const names = new Set(Array.from({ length: 20 }, () => gruntServerName()));
    expect(names.size).toBe(20);
    for (const name of names) expect(name).toMatch(/^grunt_[0-9a-f]{16}$/);
  });
});

describe("Grunt's MCP server, on raw handlers", () => {
  it('lists every tool with its JSON input schema, always loaded', async () => {
    const client = await connect([gruntArtifactTool(() => undefined), gruntRecallTool(() => undefined)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['artifact', 'recall']);
    const artifact = tools[0]!;
    expect(artifact.inputSchema.type).toBe('object');
    expect((artifact.inputSchema.properties as Record<string, { enum?: string[] }>)['command']!.enum).toContain('view');
    for (const t of tools) expect(t._meta).toEqual({ 'anthropic/alwaysLoad': true });
  });

  it('runs a call on the named tool and returns its result', async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const client = await connect([gruntArtifactTool(() => run)]);
    const result = await client.callTool({ name: 'artifact', arguments: { command: 'view', id: 'calc' } });
    expect(run).toHaveBeenCalledWith({ command: 'view', id: 'calc' });
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] });
  });

  it('answers an unknown tool, or a call that throws, as an error result rather than failing the request', async () => {
    const throwing: GruntServerTool = {
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

describe("Grunt's plan tool for Claude Code", () => {
  it("names each tool on the process's server", () => {
    expect(gruntToolName('grunt_ab', 'propose_plan')).toBe('mcp__grunt_ab__propose_plan');
  });
  it("passes the plan to the running reply and answers with the runner's text, not JSON", async () => {
    const run = vi.fn(async (_args: unknown) => 'The user approved the plan. Go ahead with it; tools that change things still need their usual approvals.');
    const def = gruntPlanTool(() => run);
    expect(def.name).toBe('propose_plan');
    expect(await def.call({ plan: '1. x' })).toEqual({ content: [{ type: 'text', text: 'The user approved the plan. Go ahead with it; tools that change things still need their usual approvals.' }], isError: false });
    expect(run).toHaveBeenCalledWith({ plan: '1. x' });
  });
  it('flags a tool error, and refuses when no reply is planning', async () => {
    const bad = await gruntPlanTool(() => async () => ({ error: true, code: 'invalid_input', message: '"plan" must be your plan, in Markdown.' })).call({});
    expect(bad).toEqual({ content: [{ type: 'text', text: '"plan" must be your plan, in Markdown.' }], isError: true });
    expect((await gruntPlanTool(() => undefined).call({ plan: 'x' })).isError).toBe(true);
  });
});
