import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import { canUseToolFor, createGate, normaliseAgentArgs, preToolUseHook } from '../src/approval.js';

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'grunt-cc-')); mkdirSync(join(ws, 'src')); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const policy: ToolPolicy = { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate' };
const ctx = (signal: AbortSignal = new AbortController().signal): ToolContext => ({ chatId: 'c', messageId: 'm', profileId: 'p', workspaceRoot: ws, signal });

describe('normaliseAgentArgs', () => {
  it('turns absolute paths into workspace-relative forward-slash paths', () => {
    expect(normaliseAgentArgs({ file_path: join(ws, 'src', 'a.ts'), old_string: 'x' }, ws)).toEqual({ args: { file_path: join(ws, 'src', 'a.ts'), old_string: 'x', path: 'src/a.ts' } });
  });
  it('accepts mixed separators and, on Windows, drive-letter case', () => {
    const mixed = `${ws.replace(/\\/g, '/')}/src/a.ts`;
    expect(normaliseAgentArgs({ file_path: mixed }, ws)).toMatchObject({ args: { path: 'src/a.ts' } });
    if (process.platform === 'win32') {
      const lower = ws[0]!.toLowerCase() + ws.slice(1) + '\\src\\a.ts';
      expect(normaliseAgentArgs({ file_path: lower }, ws)).toMatchObject({ args: { path: 'src/a.ts' } });
    }
  });
  it('reports a path outside the workspace', () => {
    const outside = process.platform === 'win32' ? 'Z:\\elsewhere\\x.txt' : '/elsewhere/x.txt';
    expect(normaliseAgentArgs({ file_path: outside }, ws)).toEqual({ outside });
    expect(normaliseAgentArgs({ file_path: join(ws, '..', 'escape.txt') }, ws)).toHaveProperty('outside');
  });
  it('leaves tools without a path alone', () => {
    expect(normaliseAgentArgs({ command: 'npm test' }, ws)).toEqual({ args: { command: 'npm test' } });
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

describe('SDK adapters', () => {
  it('hook returns allow/deny permission decisions', async () => {
    const hook = preToolUseHook(async (name) => (name === 'Bash' ? { allow: false, reason: 'no' } : { allow: true }));
    const signal = new AbortController().signal;
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} } as never, 'id', { signal })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved in Grunt' } });
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} } as never, 'id', { signal })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
  });
  it('canUseTool maps to behavior allow/deny', async () => {
    const can = canUseToolFor(async () => ({ allow: false, reason: 'no' }));
    expect(await can('Bash', { command: 'x' }, { signal: new AbortController().signal } as never)).toEqual({ behavior: 'deny', message: 'no' });
  });
});
