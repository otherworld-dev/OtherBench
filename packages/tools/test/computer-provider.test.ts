import { describe, expect, it, vi } from 'vitest';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { COMPUTER_GRUNT_REASON, COMPUTER_OFF_REASON, COMPUTER_UNATTENDED_REASON, KEYS_WINDOWS_REASON } from '@grunt/core/domain/computer-apps.js';
import { FAKE_COMPUTER_APP, FAKE_WINDOW_CHANGED_REASON, FakeComputerDriver, fakeComputerTarget } from '@grunt/core/testing/fake-computer.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ApprovalChoice, ApprovalRequest, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import { GruntToolProvider } from '../src/provider.js';
import { APP, DONE, EXPECT, EXPLORER, KEY, SHOT, UNATTENDED, ctx, policy, recordCalls, setup, unattendedCtx } from './computer-helpers.js';

/**
 * The `computer` tool through the real `GruntToolProvider` and the real
 * `PermissionBroker`, with `FakeComputerDriver` (never a real mouse, keyboard
 * or screen): listing, cards, grants, the audit and the refusals that must
 * happen before the tool is asked anything.
 */

const mcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };

function gated() {
  const { store, driver } = setup();
  const provider = new GruntToolProvider(store, new PermissionBroker(store), mcp as never, { computer: driver });
  const requests: ApprovalRequest[] = [];
  provider.onApprovalEvent((e) => {
    if (e.type === 'request') requests.push(e.request);
  });
  return { store, driver, provider, requests };
}

async function gatedTool(provider: GruntToolProvider, p: ToolPolicy = policy()): Promise<ToolSpec> {
  return (await provider.listTools(p)).find((t) => t.name === 'computer')!;
}

/** A gated tool whose chat has already taken its first screenshot (so coordinates can be checked). */
async function gatedReady(p: ToolPolicy = policy()) {
  const made = gated();
  const tool = await gatedTool(made.provider, p);
  expect(await tool.execute({ action: 'screenshot' }, ctx())).toEqual(SHOT);
  return { ...made, tool };
}

/** Runs a gated call and answers the one card it raises. */
async function answer(made: { provider: GruntToolProvider; requests: ApprovalRequest[] }, running: Promise<unknown>, choice: ApprovalChoice): Promise<unknown> {
  const before = made.requests.length;
  await vi.waitFor(() => expect(made.requests).toHaveLength(before + 1));
  made.provider.resolveApproval(made.requests.at(-1)!.id, choice);
  return running;
}

describe('the computer tool in GruntToolProvider', () => {
  it('is offered only when the profile turns it on and a driver is available', async () => {
    const store = new InMemoryStore();
    const driver = new FakeComputerDriver();
    const provider = new GruntToolProvider(store, new PermissionBroker(store), mcp as never, { computer: driver });
    const names = async (p: ToolPolicy) => (await provider.listTools(p)).map((t) => t.name);
    expect(await names(policy())).toContain('computer');
    expect(await names(policy({ computer: false }))).not.toContain('computer');
    expect(await names(policy({ computer: undefined }))).not.toContain('computer');
    expect(await names(policy({ computer: 'true' as never }))).not.toContain('computer');
    driver.isAvailable = false;
    expect(await names(policy())).not.toContain('computer');
    const without = new GruntToolProvider(store, new PermissionBroker(store), mcp as never);
    expect((await without.listTools(policy())).map((t) => t.name)).not.toContain('computer');
  });

  it('relays the computer tool to Claude Code under the same rule', () => {
    const { provider, driver } = gated();
    expect(provider.relayGruntTools(policy()).map((t) => t.name)).toEqual(['computer']);
    expect(provider.relayGruntTools(policy({ computer: false }))).toEqual([]);
    expect(provider.relayGruntTools(policy({ computer: undefined }))).toEqual([]);
    driver.isAvailable = false;
    expect(provider.relayGruntTools(policy())).toEqual([]);
  });

  it('shows no native dialog for a profile with computer use off: the tool is absent, and a kept spec is refused before it is asked anything', async () => {
    const { provider, driver, store, requests } = gated();
    const off = policy({ computer: false });
    expect((await provider.listTools(off)).map((t) => t.name)).not.toContain('computer');
    expect(provider.relayGruntTools(off)).toEqual([]);
    // A Claude Code process keeps the specs it was started with: one listed while computer use was on, called after it was turned off.
    const kept = provider.relayGruntTools(policy()).find((t) => t.name === 'computer')!;
    const calls = recordCalls(driver);
    for (const args of [{ action: 'type', text: 'x' }, { action: 'left_click', coordinate: [1, 1] }, { action: 'screenshot' }]) {
      expect(await provider.requestApproval(kept, args, off, ctx())).toEqual({ allowed: false, reason: COMPUTER_OFF_REASON });
    }
    expect(calls).toEqual([]);
    expect(driver.started).toEqual([]);
    expect(requests).toEqual([]);
    expect(store.audit.list('chat-1').map((r) => r.grantedBy)).toEqual(['deny:policy', 'deny:policy', 'deny:policy']);
  });

  it('looks with no card, asks once for the app, and a chat answer covers the next click', async () => {
    const made = gated();
    const { provider, requests, driver, store } = made;
    const tool = await gatedTool(provider, policy({ approvalMode: 'always_ask' }));
    expect(await tool.execute({ action: 'screenshot' }, ctx())).toEqual(SHOT);
    expect(await tool.execute({ action: 'cursor_position' }, ctx())).toEqual([{ type: 'text', text: 'The cursor is at 0, 0.' }]);
    expect(requests).toHaveLength(0);

    const first = tool.execute({ action: 'left_click', coordinate: [10, 20] }, ctx());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ toolName: 'computer', source: 'computer', risk: 'mutate', summary: 'Use FakeApp.exe: click at 10, 20', args: { action: 'left_click', coordinate: [10, 20], ...APP } });
    provider.resolveApproval(requests[0]!.id, { choice: 'chat' });
    expect(await first).toEqual([DONE, ...SHOT]);
    expect(store.grants.list().map((g) => ({ scope: g.scope, constraint: g.constraint, chatId: g.chatId }))).toEqual([{ scope: 'chat', constraint: { app: KEY }, chatId: 'chat-1' }]);

    expect(await tool.execute({ action: 'left_click', coordinate: [30, 40] }, ctx())).toEqual([DONE, ...SHOT]);
    expect(requests).toHaveLength(1);
    expect(driver.actions.map((a) => a.expect)).toEqual([EXPECT, EXPECT]);
    expect(driver.actions.map((a) => a.action)).toEqual([
      { action: 'left_click', coordinate: [10, 20] },
      { action: 'left_click', coordinate: [30, 40] },
    ]);
  });

  it("asks about a file dialog every time, even with a grant for the app, and a chat answer for it stores nothing and denies the call", async () => {
    const made = await gatedReady();
    const { provider, requests, driver, store, tool } = made;
    expect(await answer(made, tool.execute({ action: 'left_click', coordinate: [10, 20] }, ctx()), { choice: 'always', constraint: { app: KEY } })).toEqual([DONE, ...SHOT]);
    expect(store.grants.list().map((g) => g.constraint)).toEqual([{ app: KEY }]);
    await tool.execute({ action: 'left_click', coordinate: [11, 21] }, ctx());
    expect(requests).toHaveLength(1);

    // The same app opens its Open dialog over the point: the grant does not cover it.
    driver.pointTarget = fakeComputerTarget({ shellView: true });
    const inDialog = tool.execute({ action: 'left_click', coordinate: [12, 22] }, ctx());
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ args: { app: KEY, appShellView: true, appRisk: 'high' } });
    provider.resolveApproval(requests[1]!.id, { choice: 'once' });
    expect(await inDialog).toEqual([DONE, ...SHOT]);
    expect(driver.actions.at(-1)!.expect).toEqual({ ...EXPECT, shellView: true });

    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const again = await answer(made, tool.execute({ action: 'left_click', coordinate: [13, 23] }, ctx()), { choice: 'chat' });
      expect(again).toMatchObject({ error: true, code: 'permission_denied' });
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
    expect(requests).toHaveLength(3);
    expect(driver.actions).toHaveLength(3);
    expect(store.grants.list().map((g) => g.constraint)).toEqual([{ app: KEY }]);
  });

  it("denies the call when a high-risk app's card is answered for the chat or for always: nothing runs, nothing is stored", async () => {
    const made = await gatedReady();
    const { provider, requests, driver, store, tool } = made;
    driver.pointTarget = EXPLORER;
    const resolved: string[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'resolved') resolved.push(e.choice);
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const choice of [{ choice: 'chat' }, { choice: 'always', constraint: { app: 'C:\\Windows\\explorer.exe' } }] as ApprovalChoice[]) {
        const out = (await answer(made, tool.execute({ action: 'left_click', coordinate: [5, 5] }, ctx()), choice)) as { error: boolean; code: string; message: string };
        expect(out).toMatchObject({ error: true, code: 'permission_denied' });
        expect(out.message).toContain('Grunt asks every time for this app');
      }
      // The relayed call (Claude Code) is denied the same way.
      const spec = provider.relayGruntTools(policy()).find((t) => t.name === 'computer')!;
      const outcome = provider.requestApproval(spec, { action: 'left_click', coordinate: [5, 5] }, policy(), ctx());
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      provider.resolveApproval(requests[2]!.id, { choice: 'chat' });
      expect(await outcome).toMatchObject({ allowed: false, reason: expect.stringContaining('Grunt asks every time for this app') });
      expect(error).toHaveBeenCalledTimes(3);
    } finally {
      error.mockRestore();
    }
    expect(requests[0]).toMatchObject({ summary: 'Use explorer.exe: click at 5, 5', args: { appRisk: 'high' } });
    expect(driver.actions).toEqual([]);
    expect(driver.refused).toEqual([]);
    expect(store.grants.list()).toEqual([]);
    expect(resolved).toEqual(['deny', 'deny', 'deny']);
    expect(store.audit.list('chat-1').slice(-3).map((r) => r.grantedBy)).toEqual(['deny:policy', 'deny:policy', 'deny:policy']);
    // Allow once still works for it.
    expect(await answer(made, tool.execute({ action: 'left_click', coordinate: [5, 5] }, ctx()), { choice: 'once' })).toEqual([DONE, ...SHOT]);
  });

  it('denies the call when an always answer names another app than the card, or no app', async () => {
    const made = await gatedReady();
    const { driver, store, tool } = made;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const constraint of [{ app: 'C:\\Program Files\\Other\\other.exe' }, null, { app: KEY.toLowerCase() }]) {
        const out = await answer(made, tool.execute({ action: 'left_click', coordinate: [5, 5] }, ctx()), { choice: 'always', constraint });
        expect(out).toMatchObject({ error: true, code: 'permission_denied', message: expect.stringContaining('computer use') });
      }
    } finally {
      error.mockRestore();
    }
    expect(driver.actions).toEqual([]);
    expect(store.grants.list()).toEqual([]);
  });

  it('still runs a call of another source once when its answer cannot be stored', async () => {
    const made = gated();
    const { provider, store } = made;
    const bash: ToolSpec = { name: 'Bash', description: '', parameters: {}, risk: 'execute', source: 'agent', execute: async () => undefined };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = provider.requestApproval(bash, { command: 'npm test' }, policy({ shell: true }), ctx({ workspaceRoot: 'C:\\work' }));
      // An unconstrained "always" for a shell tool: the broker refuses to store it.
      expect(await answer(made, outcome, { choice: 'always', constraint: null })).toEqual({ allowed: true, grantedBy: 'ask:always' });
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
    expect(store.grants.list()).toEqual([]);
  });

  it('turns a refusal into an error result with no card, audited as a policy denial', async () => {
    const { provider, requests, driver, store, tool } = await gatedReady();
    driver.pointTarget = fakeComputerTarget({ grunt: true });
    expect(await tool.execute({ action: 'left_click', coordinate: [1, 1] }, ctx())).toEqual({ error: true, code: 'permission_denied', message: COMPUTER_GRUNT_REASON });
    expect(await tool.execute({ action: 'key', text: 'super+r' }, ctx())).toEqual({ error: true, code: 'permission_denied', message: KEYS_WINDOWS_REASON });
    expect(requests).toHaveLength(0);
    expect(driver.actions).toEqual([]);
    expect(store.audit.list('chat-1').slice(-2).map((r) => r.grantedBy)).toEqual(['deny:policy', 'deny:policy']);
    void provider;
  });

  it('does nothing when the window changes while its card is up', async () => {
    const made = await gatedReady();
    const { driver, tool, requests } = made;
    const running = tool.execute({ action: 'left_click', coordinate: [10, 20] }, ctx());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    // Another program's window comes up over the point while the person reads the card.
    driver.pointTarget = fakeComputerTarget({ path: 'C:\\Windows\\System32\\cmd.exe', originalName: 'Cmd.Exe', console: true, windowId: 'hwnd-7', pid: 7 });
    made.provider.resolveApproval(requests[0]!.id, { choice: 'once' });
    expect(await running).toMatchObject({ error: true, code: 'computer_refused', message: expect.stringContaining(FAKE_WINDOW_CHANGED_REASON) });
    expect(driver.actions).toEqual([]);
    expect(driver.refused.map((r) => r.expect)).toEqual([EXPECT]);
  });

  it('does nothing when the reply is stopped while its card is up', async () => {
    const made = await gatedReady();
    const { driver, tool, requests, store } = made;
    const turn = new AbortController();
    const running = tool.execute({ action: 'left_click', coordinate: [10, 20] }, ctx({ signal: turn.signal }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    turn.abort();
    expect(await running).toMatchObject({ error: true, code: 'cancelled' });
    expect(made.provider.resolveApproval(requests[0]!.id, { choice: 'once' })).toBe(false);
    expect(driver.actions).toEqual([]);
    expect(store.audit.list('chat-1').at(-1)?.grantedBy).toBe('deny:cancelled');
  });

  it('approves a relayed call with the app Grunt worked out, not the one Claude Code sent', async () => {
    const made = await gatedReady();
    const { provider, driver } = made;
    const spec = provider.relayGruntTools(policy()).find((t) => t.name === 'computer')!;
    const outcome = await answer(
      made,
      provider.requestApproval(spec, { action: 'left_click', coordinate: [1, 2], app: 'C:\\Program Files\\Trusted\\ok.exe', appWindow: 'hwnd-evil', appShellView: false }, policy(), ctx()),
      { choice: 'once' }
    );
    expect(outcome).toEqual({ allowed: true, grantedBy: 'ask:once', args: { action: 'left_click', coordinate: [1, 2], ...APP } });
    // The engine runs the spec with exactly those arguments (its approval ticket).
    expect(await spec.execute((outcome as { args: unknown }).args, ctx())).toEqual([DONE, ...SHOT]);
    expect(driver.actions).toEqual([{ chatId: 'chat-1', action: { action: 'left_click', coordinate: [1, 2] }, expect: EXPECT }]);
  });

  it('keeps typed text out of the audit, whether the call ran, was refused or was denied, and keeps a key combination', async () => {
    const made = gated();
    const { provider, store, driver } = made;
    const tool = await gatedTool(provider);
    const secret = 'hunter2 is my password';
    expect(await answer(made, tool.execute({ action: 'type', text: secret }, ctx()), { choice: 'once' })).toEqual([DONE, ...SHOT]);
    expect(store.audit.list('chat-1').at(-1)).toMatchObject({ grantedBy: 'ask:once', argsRedacted: { action: 'type', text: '[redacted: 22 characters]', app: KEY } });
    expect(await answer(made, tool.execute({ action: 'type', text: secret }, ctx()), { choice: 'deny' })).toMatchObject({ error: true, code: 'approval_denied' });
    // Refused while being described: the audit row is built from what the model sent.
    driver.foregroundTarget = fakeComputerTarget({ grunt: true });
    expect(await tool.execute({ action: 'type', text: secret }, ctx())).toMatchObject({ error: true, code: 'permission_denied' });
    // A call that is not a well-formed action at all keeps no text either.
    expect(await tool.execute({ action: 'key', text: secret }, ctx())).toMatchObject({ error: true, code: 'permission_denied' });
    expect(await tool.execute({ action: 'left_click', text: secret }, ctx())).toMatchObject({ error: true, code: 'permission_denied' });
    driver.foregroundTarget = FAKE_COMPUTER_APP;
    expect(await answer(made, tool.execute({ action: 'key', text: 'Ctrl+S' }, ctx()), { choice: 'once' })).toEqual([DONE, ...SHOT]);

    const rows = store.audit.list('chat-1');
    expect(rows).toHaveLength(6);
    expect(JSON.stringify(rows)).not.toContain('hunter2');
    expect(rows.slice(0, 5).map((r) => (r.argsRedacted as { text: string }).text)).toEqual(Array(5).fill('[redacted: 22 characters]'));
    expect(rows[5]).toMatchObject({ argsRedacted: { action: 'key', text: 'ctrl+s' } });
  });

  it('refuses every call in an unattended run, even with an always grant, audited deny:unattended, with no session start', async () => {
    for (const value of UNATTENDED) {
      const { provider, store, driver, requests } = gated();
      store.grants.create({ id: 'g1', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'always', constraint: { app: KEY }, expiresAt: null });
      const tool = await gatedTool(provider);
      const calls = recordCalls(driver);
      const refusal = { error: true, code: 'approval_unavailable', message: COMPUTER_UNATTENDED_REASON };
      for (const args of [{ action: 'type', text: 'x' }, { action: 'left_click', coordinate: [1, 2] }, { action: 'key', text: 'ctrl+s' }, { action: 'screenshot' }, { action: 'wait' }]) {
        expect(await tool.execute(args, unattendedCtx(value))).toEqual(refusal);
      }
      const spec = provider.relayGruntTools(policy()).find((t) => t.name === 'computer')!;
      expect(await provider.requestApproval(spec, { action: 'type', text: 'x' }, policy(), unattendedCtx(value))).toEqual({ allowed: false, reason: COMPUTER_UNATTENDED_REASON });
      expect(store.audit.list('chat-1').map((r) => r.grantedBy)).toEqual(Array(6).fill('deny:unattended'));
      expect(calls).toEqual([]);
      expect(driver.started).toEqual([]);
      expect(driver.actions).toEqual([]);
      expect(requests).toEqual([]);
    }
  });

  it("audits the broker's own unattended refusal as deny:unattended", async () => {
    const store = new InMemoryStore();
    const provider = new GruntToolProvider(store, new PermissionBroker(store), mcp as never);
    // A computer-source spec with no describeCall: only the broker stands in its way.
    const bare: ToolSpec = { name: 'computer', description: '', parameters: {}, risk: 'mutate', source: 'computer', execute: async () => 'ran' };
    expect(await provider.requestApproval(bare, { action: 'screenshot', app: null }, policy(), ctx({ unattended: true }))).toEqual({ allowed: false, reason: COMPUTER_UNATTENDED_REASON });
    expect(store.audit.list('chat-1').map((r) => r.grantedBy)).toEqual(['deny:unattended']);
  });

  it('raises no card and reads nothing when the reply is stopped while the start dialog is up', async () => {
    const { provider, driver, requests } = gated();
    const tool = await gatedTool(provider);
    const turn = new AbortController();
    driver.ensureSession = async () => {
      turn.abort();
      return { ok: true };
    };
    expect(await tool.execute({ action: 'type', text: 'x' }, ctx({ signal: turn.signal }))).toMatchObject({ error: true });
    expect(requests).toEqual([]);
    expect(driver.targets).toEqual([]);
    expect(driver.actions).toEqual([]);
  });
});
