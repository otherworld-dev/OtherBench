import { beforeEach, describe, expect, it } from 'vitest';
import { PermissionBroker, type Decision } from '../src/domain/permissions.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { ToolPolicy } from '../src/types/config.js';
import { InMemoryStore } from '../src/testing/fakes.js';

const EXCEL = 'c:\\program files\\microsoft office\\root\\office16\\excel.exe';
const CMD = 'c:\\windows\\system32\\cmd.exe';

const COMPUTER: ToolSpec = { name: 'computer', description: '', parameters: {}, risk: 'mutate', source: 'computer', execute: async () => null };

function policy(over: Partial<ToolPolicy> = {}): ToolPolicy {
  return { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', computer: true, ...over };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal, ...over };
}

function click(app: string | null = EXCEL, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { action: 'left_click', coordinate: [512, 300], ...(app === null ? {} : { app, appName: app === CMD ? 'cmd' : 'EXCEL', appRisk: app === CMD ? 'high' : 'normal' }), ...extra };
}

function expectAsk(decision: Decision): Extract<Decision, { kind: 'ask' }> {
  if (decision.kind !== 'ask') throw new Error(`Expected ask, got ${JSON.stringify(decision)}`);
  return decision;
}

describe('PermissionBroker and computer use', () => {
  let store: InMemoryStore;
  let broker: PermissionBroker;

  beforeEach(() => {
    store = new InMemoryStore();
    broker = new PermissionBroker(store);
  });

  it('refuses every action while the profile has computer use off', () => {
    for (const p of [policy({ computer: false }), policy({ computer: undefined })]) {
      expect(broker.decide(COMPUTER, { action: 'screenshot', app: null }, p, ctx())).toEqual({ kind: 'deny', reason: 'Computer use is turned off for this profile.' });
    }
  });

  it('refuses an unattended run, even with an always grant for the app, and even a screenshot', () => {
    store.grants.create({ id: 'g1', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'always', constraint: { app: EXCEL }, expiresAt: null });
    const reason = 'Computer use needs someone at the machine; it never runs unattended.';
    expect(broker.decide(COMPUTER, click(), policy(), ctx({ unattended: true }))).toEqual({ kind: 'deny', reason, unattended: true });
    expect(broker.decide(COMPUTER, { action: 'screenshot', app: null }, policy(), ctx({ unattended: true }))).toEqual({ kind: 'deny', reason, unattended: true });
  });

  it('lets a screenshot, the cursor position and a wait through with no card, in both approval modes', () => {
    for (const approvalMode of ['always_ask', 'ask_on_mutate'] as const) {
      for (const action of ['screenshot', 'cursor_position', 'wait']) {
        expect(broker.decide(COMPUTER, { action, app: null }, policy({ approvalMode }), ctx())).toEqual({ kind: 'allow', grantedBy: 'policy' });
      }
    }
  });

  it('goes by the action name, not the declared risk', () => {
    const lying: ToolSpec = { ...COMPUTER, risk: 'read' };
    expect(broker.decide(lying, click(), policy(), ctx()).kind).toBe('ask');
  });

  it('refuses an action with no app, and an action it does not know', () => {
    expect(broker.decide(COMPUTER, click(null), policy(), ctx())).toEqual({ kind: 'deny', reason: "Grunt couldn't tell which app this action would use, so it didn't run it." });
    expect(broker.decide(COMPUTER, { action: 'left_click_drag', app: EXCEL }, policy(), ctx()).kind).toBe('deny');
  });

  it('asks about a click, naming the app; a chat answer stores a grant for that app only', () => {
    const ask = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    expect(ask.request).toMatchObject({ toolName: 'computer', source: 'computer', summary: 'Use EXCEL: click at 512, 300' });
    broker.resolve(ask.request.id, { choice: 'chat' });
    const [grant] = store.grants.list();
    expect(grant).toMatchObject({ chatId: 'chat-1', profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'chat', constraint: { app: EXCEL } });

    expect(broker.decide(COMPUTER, click(EXCEL, { coordinate: [10, 10] }), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(broker.decide(COMPUTER, click('C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE'), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(broker.decide(COMPUTER, click('c:\\users\\adam\\downloads\\excel.exe'), policy(), ctx()).kind).toBe('ask');
    expect(broker.decide(COMPUTER, click(), policy(), ctx({ chatId: 'chat-2' })).kind).toBe('ask');
  });

  it('needs an app on an always answer', () => {
    const first = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    expect(() => broker.resolve(first.request.id, { choice: 'always', constraint: null })).toThrow(/computer use/);
    expect(store.grants.list()).toEqual([]);
    const second = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    broker.resolve(second.request.id, { choice: 'always', constraint: { app: EXCEL } });
    expect(store.grants.list()[0]).toMatchObject({ scope: 'always', chatId: null, constraint: { app: EXCEL } });
    expect(broker.decide(COMPUTER, click(), policy(), ctx({ chatId: 'chat-9' }))).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
  });

  it('refuses an always answer that names another app than the card asked about', () => {
    const ask = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    expect(() => broker.resolve(ask.request.id, { choice: 'always', constraint: { app: 'c:\\users\\adam\\downloads\\excel.exe' } })).toThrow(
      "Refusing an \"always\" grant for computer use that doesn't name the app the card asked about (c:\\program files\\microsoft office\\root\\office16\\excel.exe)."
    );
    expect(store.grants.list()).toEqual([]);
    expect(broker.decide(COMPUTER, click('c:\\users\\adam\\downloads\\excel.exe'), policy(), ctx()).kind).toBe('ask');
  });

  it("stores only the card's app on an always answer, whatever else the answer carries", () => {
    const ask = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    broker.resolve(ask.request.id, { choice: 'always', constraint: { app: 'C:/Program Files/Microsoft Office/root/Office16/EXCEL.EXE', commandExact: 'x' } });
    const grants = store.grants.list();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ scope: 'always', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer' });
    expect(grants[0]?.constraint).toEqual({ app: EXCEL });
  });

  it('ignores a computer grant that names no app', () => {
    store.grants.create({ id: 'blanket', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'always', constraint: null, expiresAt: null });
    store.grants.create({ id: 'other-key', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'always', constraint: { commandExact: 'x' }, expiresAt: null });
    expect(broker.decide(COMPUTER, click(), policy(), ctx()).kind).toBe('ask');
  });

  it('stores nothing for a high-risk app, and ignores a grant that exists for one', () => {
    const chat = expectAsk(broker.decide(COMPUTER, click(CMD), policy(), ctx()));
    broker.resolve(chat.request.id, { choice: 'chat' });
    const always = expectAsk(broker.decide(COMPUTER, click(CMD), policy(), ctx()));
    broker.resolve(always.request.id, { choice: 'always', constraint: { app: CMD } });
    expect(store.grants.list()).toEqual([]);

    store.grants.create({ id: 'old', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'always', constraint: { app: CMD }, expiresAt: null });
    expect(broker.decide(COMPUTER, click(CMD), policy(), ctx()).kind).toBe('ask');
  });

  it('treats an app the tool marked high-risk as high-risk even when its name is not on the list', () => {
    const odd = 'c:\\tools\\admin-console.exe';
    const ask = expectAsk(broker.decide(COMPUTER, click(odd, { appRisk: 'high' }), policy(), ctx()));
    broker.resolve(ask.request.id, { choice: 'chat' });
    expect(store.grants.list()).toEqual([]);
  });

  it('keeps a long typed text to one short line in the card', () => {
    const ask = expectAsk(broker.decide(COMPUTER, { action: 'type', text: `${'a'.repeat(45)}\nsecond line`, app: EXCEL, appName: 'EXCEL' }, policy(), ctx()));
    expect(ask.request.summary).toBe(`Use EXCEL: type "${'a'.repeat(40)}…"`);
  });

  it("never lets another source's grant stand in for computer use", () => {
    store.grants.create({ id: 'mcp', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'mcp', scope: 'always', constraint: { app: EXCEL }, expiresAt: null });
    expect(broker.decide(COMPUTER, click(), policy(), ctx()).kind).toBe('ask');
  });
});
