import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import { canUseToolFor, createGate, isDriveLetterPosixPath, normaliseAgentArgs, permissionDeniedHook, preToolUseHook } from '../src/approval.js';

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'grunt-cc-')); mkdirSync(join(ws, 'src')); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const policy: ToolPolicy = { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate' };
const ctx = (signal: AbortSignal = new AbortController().signal): ToolContext => ({ chatId: 'c', messageId: 'm', profileId: 'p', workspaceRoot: ws, signal });

describe('normaliseAgentArgs', () => {
  it('turns absolute paths into workspace-relative forward-slash paths', () => {
    expect(normaliseAgentArgs('Read', { file_path: join(ws, 'src', 'a.ts'), old_string: 'x' }, ws)).toEqual({ args: { file_path: join(ws, 'src', 'a.ts'), old_string: 'x', path: 'src/a.ts' } });
  });
  it('accepts mixed separators and, on Windows, drive-letter case', () => {
    const mixed = `${ws.replace(/\\/g, '/')}/src/a.ts`;
    expect(normaliseAgentArgs('Read', { file_path: mixed }, ws)).toMatchObject({ args: { path: 'src/a.ts' } });
    if (process.platform === 'win32') {
      const lower = ws[0]!.toLowerCase() + ws.slice(1) + '\\src\\a.ts';
      expect(normaliseAgentArgs('Read', { file_path: lower }, ws)).toMatchObject({ args: { path: 'src/a.ts' } });
    }
  });
  it('reports a path outside the workspace', () => {
    const outside = process.platform === 'win32' ? 'Z:\\elsewhere\\x.txt' : '/elsewhere/x.txt';
    expect(normaliseAgentArgs('Read', { file_path: outside }, ws)).toEqual({ outside });
    expect(normaliseAgentArgs('Read', { file_path: join(ws, '..', 'escape.txt') }, ws)).toHaveProperty('outside');
  });
  it('leaves tools without a path alone', () => {
    expect(normaliseAgentArgs('Bash', { command: 'npm test' }, ws)).toEqual({ args: { command: 'npm test' } });
  });
});

describe('createGate', () => {
  it('sends a classified agent ToolSpec with normalised args to requestApproval', async () => {
    const requestApproval = vi.fn(async (_t: ToolSpec) => ({ allowed: true as const, grantedBy: 'ask:once' }));
    const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx() });
    expect(await gate('Edit', { file_path: join(ws, 'src', 'a.ts') })).toEqual({ allow: true });
    const [spec, args] = requestApproval.mock.calls[0]!;
    expect(spec).toMatchObject({ name: 'Edit', source: 'agent', risk: 'mutate' });
    expect(args).toMatchObject({ path: 'src/a.ts' });
  });
  it('denies outside-workspace paths without asking', async () => {
    const requestApproval = vi.fn();
    const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx() });
    const outside = process.platform === 'win32' ? 'Z:\\x.txt' : '/x.txt';
    expect(await gate('Write', { file_path: outside })).toEqual({ allow: false, reason: expect.stringContaining('outside') });
    expect(requestApproval).not.toHaveBeenCalled();
  });
  it('passes denials through with their reason', async () => {
    const gate = createGate({ approvals: { requestApproval: async () => ({ allowed: false, reason: 'nope' }) }, policy, ctx: ctx() });
    expect(await gate('Bash', { command: 'rm -rf /' })).toEqual({ allow: false, reason: 'nope' });
  });
  it('denies without asking when the turn is already aborted', async () => {
    const requestApproval = vi.fn();
    const ac = new AbortController();
    ac.abort();
    const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx(ac.signal) });
    expect(await gate('Bash', { command: 'ls' })).toEqual({ allow: false, reason: 'The turn was stopped.' });
    expect(requestApproval).not.toHaveBeenCalled();
  });
});

describe('containment hardening', () => {
  const outsideAbs = process.platform === 'win32' ? 'Z:\\elsewhere\\x.txt' : '/elsewhere/x.txt';
  const run = async (tool: string, input: Record<string, unknown>) => {
    const requestApproval = vi.fn(async (_t: ToolSpec, _a: Record<string, unknown>) => ({ allowed: true as const, grantedBy: 'ask:once' }));
    const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx() });
    return { decision: await gate(tool, input), requestApproval };
  };
  const denied = async (tool: string, input: Record<string, unknown>) => {
    const { decision, requestApproval } = await run(tool, input);
    expect(decision.allow).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
  };

  it.each(['~/x', '~\\x', '~'])('denies Read of %s', async (p) => { await denied('Read', { file_path: p }); });
  it('denies leading whitespace before an outside path', async () => {
    await denied('Read', { file_path: '  ' + outsideAbs });
    await denied('Read', { file_path: '\t/etc/passwd' });
  });
  it('trims whitespace around an inside path', async () => {
    const { decision, requestApproval } = await run('Read', { file_path: `  ${join(ws, 'src', 'a.ts')} \n` });
    expect(decision).toEqual({ allow: true });
    expect(requestApproval.mock.calls[0]![1]).toMatchObject({ path: 'src/a.ts' });
  });
  it('denies non-string or empty path values', async () => {
    await denied('Read', { file_path: 42 });
    await denied('Read', { file_path: '   ' });
  });
  it('contains every present path key, not just the first', async () => {
    await denied('Grep', { file_path: join(ws, 'src'), path: outsideAbs });
  });
  it('handles relative input, the root itself and notebook_path', async () => {
    expect(normaliseAgentArgs('Read', { file_path: 'src/a.ts' }, ws)).toMatchObject({ args: { path: 'src/a.ts' } });
    expect(normaliseAgentArgs('Read', { file_path: ws }, ws)).toMatchObject({ args: { path: '.' } });
    expect(normaliseAgentArgs('NotebookEdit', { notebook_path: join(ws, 'n.ipynb') }, ws)).toMatchObject({ args: { path: 'n.ipynb' } });
  });
  it('contains Glob patterns and Grep globs', async () => {
    await denied('Glob', { pattern: outsideAbs.replace(/[^\\/]+$/, '**/*.pem') });
    await denied('Glob', { pattern: '../**' });
    await denied('Glob', { pattern: '~/**/*.pem' });
    await denied('Grep', { pattern: 'x', glob: outsideAbs.replace(/[^\\/]+$/, '*.txt') });
    expect((await run('Glob', { pattern: `${ws.replace(/\\/g, '/')}/src/**/*.ts` })).decision).toEqual({ allow: true });
    expect((await run('Glob', { pattern: 'src/**/*.ts' })).decision).toEqual({ allow: true });
  });
  it('recognises MSYS-style drive paths only on Windows', () => {
    for (const v of ['/c/Windows/win.ini', '\\c\\x', '/D', '/d/', '/c']) expect(isDriveLetterPosixPath(v, 'win32')).toBe(true);
    for (const v of ['/cc/x', 'c/x', '/1/x', 'C:\\x', '/', 'src/a.ts', '/c-x']) expect(isDriveLetterPosixPath(v, 'win32')).toBe(false);
    expect(isDriveLetterPosixPath('/c/Windows/win.ini', 'linux')).toBe(false);
    expect(isDriveLetterPosixPath('/c/Windows/win.ini', 'darwin')).toBe(false);
  });
  it.runIf(process.platform === 'win32')('treats /c/... paths and patterns as outside on Windows, even with a drive-root workspace', async () => {
    // Claude Code reads /c/Windows/win.ini as C:\Windows\win.ini, but containPath
    // resolves it on the server's current drive (<drive>:\c\Windows\win.ini),
    // which a workspace at that drive's root would contain.
    const driveRoot = parse(process.cwd()).root;
    expect(normaliseAgentArgs('Read', { file_path: '/c/Windows/win.ini' }, driveRoot)).toEqual({ outside: '/c/Windows/win.ini' });
    expect(normaliseAgentArgs('Read', { file_path: ' /c/Windows/win.ini' }, driveRoot)).toEqual({ outside: ' /c/Windows/win.ini' });
    expect(normaliseAgentArgs('Grep', { pattern: 'x', path: '/c/Windows' }, driveRoot)).toEqual({ outside: '/c/Windows' });
    expect(normaliseAgentArgs('Glob', { pattern: '/c/Windows/*.ini' }, driveRoot)).toEqual({ outside: '/c/Windows/*.ini' });
    expect(normaliseAgentArgs('Grep', { pattern: 'x', glob: '/c/**/*.ini' }, driveRoot)).toEqual({ outside: '/c/**/*.ini' });
    await denied('Read', { file_path: '/c/Windows/win.ini' });
    await denied('Glob', { pattern: '/c/Users/**' });
  });
  it('leaves MCP tool args alone', async () => {
    const { decision, requestApproval } = await run('mcp__gh__get_file', { path: '/README.md' });
    expect(decision).toEqual({ allow: true });
    expect(requestApproval.mock.calls[0]![1]).toEqual({ path: '/README.md' });
  });
  it('fails closed when requestApproval throws', async () => {
    const gate = createGate({ approvals: { requestApproval: async () => { throw new Error('db down'); } }, policy, ctx: ctx() });
    expect(await gate('Bash', { command: 'ls' })).toEqual({ allow: false, reason: expect.stringContaining('could not check') });
  });
});

describe('SDK adapters', () => {
  it('hook ignores non-PreToolUse events', async () => {
    const hook = preToolUseHook(async () => ({ allow: true }));
    expect(await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read' } as never, 'id', { signal: new AbortController().signal })).toEqual({});
  });
  it('hook and canUseTool fail closed if the gate throws', async () => {
    const boom = async (): Promise<never> => { throw new Error('boom'); };
    const out = await preToolUseHook(boom)({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} } as never, 'id', { signal: new AbortController().signal });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await canUseToolFor(boom)('Read', {}, { signal: new AbortController().signal } as never)).toMatchObject({ behavior: 'deny' });
  });
  it('canUseTool allow returns the original input', async () => {
    const input = { command: 'x' };
    expect(await canUseToolFor(async () => ({ allow: true }))('Bash', input, { signal: new AbortController().signal } as never)).toEqual({ behavior: 'allow', updatedInput: input });
  });
  it('hook returns allow/deny permission decisions', async () => {
    const hook = preToolUseHook(async (name) => (name === 'Bash' ? { allow: false, reason: 'no' } : { allow: true }));
    const signal = new AbortController().signal;
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} } as never, 'id', { signal })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved in Grunt' } });
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} } as never, 'id', { signal })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
  });
  describe('when Claude Code gives up on a pending call (hook signal aborts)', () => {
    /** Like GruntToolProvider.awaitApproval: a pending card settles as a denial when ctx.signal aborts. */
    const pendingCard = () => {
      const seen: AbortSignal[] = [];
      const requestApproval = vi.fn((_t: ToolSpec, _a: unknown, _p: ToolPolicy, c: ToolContext) => {
        seen.push(c.signal);
        return new Promise<{ allowed: false; reason: string }>((resolve) => {
          c.signal.addEventListener('abort', () => resolve({ allowed: false, reason: 'The user denied this tool call.' }), { once: true });
        });
      });
      return { requestApproval, seen };
    };

    it('settles the pending approval as a denial without stopping the turn', async () => {
      const { requestApproval, seen } = pendingCard();
      const turn = new AbortController();
      const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx(turn.signal) });
      const hookCall = new AbortController();
      const out = preToolUseHook(gate)({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } as never, 'id', { signal: hookCall.signal });
      await vi.waitFor(() => expect(requestApproval).toHaveBeenCalled());
      expect(seen[0]!.aborted).toBe(false);
      hookCall.abort();
      expect(await out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
      expect(seen[0]!.aborted).toBe(true);
      expect(turn.signal.aborted).toBe(false);
    });

    it('still settles on the turn signal', async () => {
      const { requestApproval } = pendingCard();
      const turn = new AbortController();
      const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx(turn.signal) });
      const out = canUseToolFor(gate)('Bash', { command: 'ls' }, { signal: new AbortController().signal } as never);
      await vi.waitFor(() => expect(requestApproval).toHaveBeenCalled());
      turn.abort();
      expect(await out).toMatchObject({ behavior: 'deny' });
    });

    it('does not raise a card for a call Claude Code already gave up on', async () => {
      const { requestApproval } = pendingCard();
      const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx() });
      const hookCall = new AbortController();
      hookCall.abort();
      expect(await gate('Bash', { command: 'ls' }, hookCall.signal)).toMatchObject({ allow: false });
      expect(requestApproval).not.toHaveBeenCalled();
    });
  });

  it('canUseTool maps to behavior allow/deny', async () => {
    const can = canUseToolFor(async () => ({ allow: false, reason: 'no' }));
    expect(await can('Bash', { command: 'x' }, { signal: new AbortController().signal } as never)).toEqual({ behavior: 'deny', message: 'no' });
  });
});

describe('auto mode gate', () => {
  const deferring = () => vi.fn(async (..._a: unknown[]) => ({ deferred: true as const }));
  const allowing = () => vi.fn(async (..._a: unknown[]) => ({ allowed: true as const, grantedBy: 'ask:once' }));
  const hookInput = (tool_name: string, tool_input: unknown) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input }) as never;
  const sig = () => ({ signal: new AbortController().signal });
  const outsidePath = process.platform === 'win32' ? 'Z:\\x.txt' : '/x.txt';

  it('asks requestApproval to defer on the hook path in auto mode, and returns defer', async () => {
    const requestApproval = deferring();
    const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx(), autoMode: true });
    expect(await gate('Bash', { command: 'npm test' }, undefined, { mayDefer: true })).toEqual({ defer: true });
    expect(requestApproval.mock.calls[0]![4]).toEqual({ deferAsk: true });
  });

  it('never asks to defer outside auto mode, or without mayDefer', async () => {
    const requestApproval = allowing();
    await createGate({ approvals: { requestApproval }, policy, ctx: ctx() })('Bash', { command: 'ls' }, undefined, { mayDefer: true });
    await createGate({ approvals: { requestApproval }, policy, ctx: ctx(), autoMode: true })('Bash', { command: 'ls' });
    expect(requestApproval.mock.calls.map((c) => c[4])).toEqual([{ deferAsk: false }, { deferAsk: false }]);
  });

  it('still denies an outside-workspace path in auto mode without asking', async () => {
    const requestApproval = deferring();
    const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx(), autoMode: true });
    expect(await gate('Write', { file_path: outsidePath }, undefined, { mayDefer: true })).toMatchObject({ allow: false });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('still short-circuits an aborted turn in auto mode without asking', async () => {
    const requestApproval = deferring();
    const ac = new AbortController();
    ac.abort();
    const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx(ac.signal), autoMode: true });
    expect(await gate('Bash', { command: 'ls' }, undefined, { mayDefer: true })).toMatchObject({ allow: false });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('fails closed if requestApproval defers a call it was not asked to defer', async () => {
    const gate = createGate({ approvals: { requestApproval: deferring() }, policy, ctx: ctx(), autoMode: true });
    expect(await gate('Bash', { command: 'ls' })).toMatchObject({ allow: false });
  });

  it('the hook returns an empty result (no decision) for a deferred call, never permissionDecision "defer"', async () => {
    const gate = createGate({ approvals: { requestApproval: deferring() }, policy, ctx: ctx(), autoMode: true });
    const out = await preToolUseHook(gate)(hookInput('Bash', { command: 'npm test' }), 'id', sig());
    expect(out).toEqual({});
    expect(JSON.stringify(out)).not.toContain('defer');
  });

  it('the hook still allows and denies explicitly in auto mode', async () => {
    const gate = createGate({ approvals: { requestApproval: allowing() }, policy, ctx: ctx(), autoMode: true });
    expect(await preToolUseHook(gate)(hookInput('Bash', { command: 'ls' }), 'id', sig())).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(await preToolUseHook(gate)(hookInput('Write', { file_path: outsidePath }), 'id', sig())).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('a requestApproval that throws in auto mode makes the hook DENY, never an empty result', async () => {
    const requestApproval = vi.fn(async (..._a: unknown[]) => { throw new Error('store down'); });
    const gate = createGate({ approvals: { requestApproval: requestApproval as never }, policy, ctx: ctx(), autoMode: true });
    const out = await preToolUseHook(gate)(hookInput('Bash', { command: 'npm test' }), 'id', sig());
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    expect(out).not.toEqual({});
  });

  it('outside auto mode a deferred outcome makes the hook DENY', async () => {
    const gate = createGate({ approvals: { requestApproval: deferring() }, policy, ctx: ctx() });
    const out = await preToolUseHook(gate)(hookInput('Bash', { command: 'npm test' }), 'id', sig());
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('only an outcome with deferred === true defers', async () => {
    const odd = vi.fn(async (..._a: unknown[]) => ({ allowed: false as const, reason: 'no', deferred: false }));
    const gate = createGate({ approvals: { requestApproval: odd as never }, policy, ctx: ctx(), autoMode: true });
    expect(await gate('Bash', { command: 'ls' }, undefined, { mayDefer: true })).toEqual({ allow: false, reason: 'no' });
  });

  it('canUseTool never defers: it gets a card through requestApproval without deferAsk', async () => {
    const requestApproval = allowing();
    const gate = createGate({ approvals: { requestApproval }, policy, ctx: ctx(), autoMode: true });
    expect(await canUseToolFor(gate)('Bash', { command: 'npm test' }, sig() as never)).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    expect(requestApproval.mock.calls[0]![4]).toEqual({ deferAsk: false });
  });

  it('canUseTool denies if a gate ever answers defer to it', async () => {
    expect(await canUseToolFor(async () => ({ defer: true }))('Bash', {}, sig() as never)).toMatchObject({ behavior: 'deny' });
  });
});

describe('permissionDeniedHook', () => {
  const signal = () => ({ signal: new AbortController().signal });
  const FALLBACK = 'Blocked by Claude Code auto mode.';

  it('records the block with workspace-relative args and the classifier reason', async () => {
    const recordAgentDenial = vi.fn();
    const hook = permissionDeniedHook({ approvals: { recordAgentDenial }, ctx: ctx() });
    const file = join(ws, 'src', 'a.ts');
    const out = await hook({ hook_event_name: 'PermissionDenied', tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: 't1', reason: 'Edits outside the task' } as never, 't1', signal());
    expect(out).toEqual({});
    expect(recordAgentDenial).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c', messageId: 'm', profileId: 'p' }), 'Edit', { file_path: file, path: 'src/a.ts' }, 'Edits outside the task');
  });

  it('records the raw args when they cannot be normalised', async () => {
    const recordAgentDenial = vi.fn();
    const outside = process.platform === 'win32' ? 'Z:\\x.txt' : '/x.txt';
    await permissionDeniedHook({ approvals: { recordAgentDenial }, ctx: ctx() })({ hook_event_name: 'PermissionDenied', tool_name: 'Write', tool_input: { file_path: outside }, tool_use_id: 't1', reason: 'r' } as never, 't1', signal());
    expect(recordAgentDenial.mock.calls[0]![2]).toEqual({ file_path: outside });
  });

  it('ignores other hook events', async () => {
    const recordAgentDenial = vi.fn();
    expect(await permissionDeniedHook({ approvals: { recordAgentDenial }, ctx: ctx() })({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} } as never, 'id', signal())).toEqual({});
    expect(recordAgentDenial).not.toHaveBeenCalled();
  });

  it('never throws when recording fails', async () => {
    const recordAgentDenial = vi.fn(() => { throw new Error('db gone'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(permissionDeniedHook({ approvals: { recordAgentDenial }, ctx: ctx() })({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't1', reason: 'r' } as never, 't1', signal())).resolves.toEqual({});
    err.mockRestore();
  });

  it('coerces a malformed payload at the boundary', async () => {
    const recordAgentDenial = vi.fn();
    const hook = permissionDeniedHook({ approvals: { recordAgentDenial }, ctx: ctx() });
    await hook({ hook_event_name: 'PermissionDenied', tool_name: 42, tool_input: 'nope', reason: { x: 1 } } as never, 'id', signal());
    await hook({ hook_event_name: 'PermissionDenied', tool_name: 'B'.repeat(500), tool_input: [1, 2], reason: '   ' } as never, 'id', signal());
    await hook({ hook_event_name: 'PermissionDenied', tool_input: null } as never, 'id', signal());
    const calls = recordAgentDenial.mock.calls as unknown[][];
    expect(calls).toHaveLength(3);
    expect(typeof calls[0]![1]).toBe('string');
    expect(calls[0]![2]).toEqual({});
    expect(calls[0]![3]).toBe(FALLBACK);
    expect(calls[1]![1]).toHaveLength(200);
    expect(calls[1]![2]).toEqual({});
    expect(calls[1]![3]).toBe(FALLBACK);
    expect(typeof calls[2]![1]).toBe('string');
    expect(calls[2]![2]).toEqual({});
  });
});
