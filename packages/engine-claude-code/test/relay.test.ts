import { describe, expect, it, vi } from 'vitest';
import type { ToolSpec } from '@grunt/core/ports/tool-provider.js';
import { buildRelay, relayName, relayServerTool } from '../src/relay.js';

const spec = (o: Partial<ToolSpec> = {}): ToolSpec => ({
  name: 'mcp__nextcloud__deck_add',
  description: 'Add a Deck card',
  parameters: { type: 'object', properties: { title: { type: 'string' } } },
  risk: 'mutate',
  source: 'mcp',
  serverId: 's1',
  execute: async () => [{ type: 'text', text: 'ok' }],
  ...o,
});
const SERVER = 'grunt_0123456789abcdef';

describe('relayName', () => {
  it("drops the mcp__ prefix of the API model's name", () => {
    expect(relayName('mcp__nextcloud__deck_add')).toBe('nextcloud__deck_add');
  });

  it('cuts a long name to fit the 64-character tool-name limit, with a stable hash so two long names stay apart', () => {
    const a = `mcp__${'a'.repeat(40)}__${'b'.repeat(40)}`;
    const b = `mcp__${'a'.repeat(40)}__${'c'.repeat(40)}`;
    expect(`mcp__${SERVER}__${relayName(a)}`.length).toBeLessThanOrEqual(64);
    expect(relayName(a)).toMatch(/_[0-9a-f]{6}$/);
    expect(relayName(a)).toBe(relayName(a));
    expect(relayName(a)).not.toBe(relayName(b));
  });
});

describe('buildRelay', () => {
  it('maps each relay name to its spec, with a hash that changes when any tool does', () => {
    const relay = buildRelay([spec()]);
    expect([...relay.tools.keys()]).toEqual(['nextcloud__deck_add']);
    expect(relay.tools.get('nextcloud__deck_add')!.serverId).toBe('s1');
    expect(buildRelay([spec()]).hash).toBe(relay.hash);
    expect(buildRelay([spec({ parameters: { type: 'object' } })]).hash).not.toBe(relay.hash);
    expect(buildRelay([spec({ serverId: 's2' })]).hash).not.toBe(relay.hash);
    expect(buildRelay([]).hash).toBe('');
  });
});

describe('relayServerTool', () => {
  it("lists the tool with its server's own schema, and runs a call on the running reply", async () => {
    const run = vi.fn(async () => [{ type: 'text', text: 'card added' }]);
    const tool = relayServerTool('nextcloud__deck_add', spec(), () => run);
    expect(tool).toMatchObject({ name: 'nextcloud__deck_add', description: 'Add a Deck card', inputSchema: spec().parameters });
    expect(await tool.call({ title: 'x' })).toEqual({ content: [{ type: 'text', text: 'card added' }] });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: 'mcp__nextcloud__deck_add' }), { title: 'x' });
  });

  it('answers a tool error, a call that throws, or no running reply as an error result', async () => {
    const failed = relayServerTool('t', spec(), () => async () => ({ error: true, code: 'mcp_tool_error', message: 'Board not found' }));
    expect(await failed.call({})).toEqual({ content: [{ type: 'text', text: 'Board not found' }], isError: true });
    const thrown = relayServerTool('t', spec(), () => async () => {
      throw new Error('server went away');
    });
    expect(await thrown.call({})).toEqual({ content: [{ type: 'text', text: 'server went away' }], isError: true });
    const idle = await relayServerTool('t', spec(), () => undefined).call({});
    expect(idle.isError).toBe(true);
  });
});
