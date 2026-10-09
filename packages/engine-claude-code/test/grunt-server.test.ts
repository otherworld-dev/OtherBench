import { describe, expect, it, vi } from 'vitest';
import { gruntArtifactTool, gruntRecallTool, gruntServerName } from '../src/grunt-server.js';

describe("Grunt's own tools for Claude Code", () => {
  it('passes the call to the running reply and returns its outcome as JSON, flagging errors', async () => {
    const run = vi.fn(async (args: unknown) => ({ ok: true, echoed: args }));
    const def = gruntArtifactTool(() => run);
    expect(def.name).toBe('artifact');
    const ok = await def.handler({ command: 'view', id: 'calc' }, {});
    expect(run).toHaveBeenCalledWith({ command: 'view', id: 'calc' });
    expect(ok).toEqual({ content: [{ type: 'text', text: JSON.stringify({ ok: true, echoed: { command: 'view', id: 'calc' } }) }], isError: false });

    const failing = gruntArtifactTool(() => async () => ({ error: true, code: 'unknown_id', message: 'No artifact "x".' }));
    expect((await failing.handler({ command: 'view', id: 'x' }, {})).isError).toBe(true);
  });

  it('refuses when no Grunt reply is running or artifacts are off', async () => {
    const result = await gruntArtifactTool(() => undefined).handler({ command: 'view', id: 'x' }, {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Artifacts are turned off for this profile, or no Grunt reply is running.');
  });

  it('offers recall on the same server: the call goes to the running reply, and is refused when none is running or recall is off', async () => {
    const run = vi.fn(async (args: unknown) => ({ chats: [], projects: [], echoed: args }));
    const def = gruntRecallTool(() => run);
    expect(def.name).toBe('recall');
    const ok = await def.handler({ command: 'search', query: 'hetzner' }, {});
    expect(run).toHaveBeenCalledWith({ command: 'search', query: 'hetzner' });
    expect(ok.isError).toBe(false);

    const off = await gruntRecallTool(() => undefined).handler({ command: 'search', query: 'x' }, {});
    expect(off.isError).toBe(true);
    expect(JSON.stringify(off.content)).toContain('Searching past chats is turned off for this profile, or no Grunt reply is running.');
  });

  it("names each process's server afresh, so a project's MCP config can't take the name", () => {
    const names = new Set(Array.from({ length: 20 }, () => gruntServerName()));
    expect(names.size).toBe(20);
    for (const name of names) expect(name).toMatch(/^grunt_[0-9a-f]{16}$/);
  });
});
