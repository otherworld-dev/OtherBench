import { describe, expect, it, vi } from 'vitest';
import { gruntArtifactTool, gruntServerName } from '../src/artifact-server.js';

describe("Grunt's artifact tool for Claude Code", () => {
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

  it("names each process's server afresh, so a project's MCP config can't take the name", () => {
    const names = new Set(Array.from({ length: 20 }, () => gruntServerName()));
    expect(names.size).toBe(20);
    for (const name of names) expect(name).toMatch(/^grunt_[0-9a-f]{16}$/);
  });
});
