import { beforeEach, describe, expect, it } from 'vitest';
import { PermissionBroker, type Decision } from '../src/domain/permissions.js';
import type { Grant } from '../src/ports/store.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { ToolPolicy } from '../src/types/config.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import { appArgs, classifyTarget } from '../src/domain/computer-apps.js';
import { fakeComputerTarget } from '../src/testing/fake-computer.js';

// App keys are the paths the shell resolved, compared exactly: on-disk case and all.
const EXCEL = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE';
const DOWNLOADED_EXCEL = 'C:\\Users\\Adam\\Downloads\\EXCEL.EXE';
const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const NO_APP = "Grunt couldn't tell which app this action would use, so it didn't run it.";

const COMPUTER: ToolSpec = { name: 'computer', description: '', parameters: {}, risk: 'mutate', source: 'computer', execute: async () => null };

function policy(over: Partial<ToolPolicy> = {}): ToolPolicy {
  return { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', computer: true, ...over };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal, ...over };
}

/**
 * A described click: what the tool's describeCall hands the broker. `app: null` leaves the app fields out. An `extra`
 * that makes it a type or key action leaves the point out too (those actions have none) unless it gives one.
 */
function click(app: unknown = EXCEL, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const described = app === null ? {} : { app, appName: 'whatever the caller says', appTitle: 'Book1', appRisk: app === CMD ? 'high' : 'normal', appShellView: false, appWindow: 'hwnd-1', appPid: 4242, appStarted: 't0' };
  const args: Record<string, unknown> = { action: 'left_click', coordinate: [512, 300], ...described, ...extra };
  if (!('coordinate' in extra) && (args['action'] === 'type' || args['action'] === 'key')) delete args['coordinate'];
  return args;
}

function expectAsk(decision: Decision): Extract<Decision, { kind: 'ask' }> {
  if (decision.kind !== 'ask') throw new Error(`Expected ask, got ${JSON.stringify(decision)}`);
  return decision;
}

describe('PermissionBroker and computer use', () => {
  let store: InMemoryStore;
  let broker: PermissionBroker;

  function grant(app: unknown, over: Record<string, unknown> = {}): void {
    store.grants.create({
      id: `g${store.grants.list().length + 1}`,
      chatId: null,
      profileId: 'profile-1',
      toolName: 'computer',
      source: 'computer',
      scope: 'always',
      constraint: { app: app as string },
      expiresAt: null,
      ...over,
    });
  }

  beforeEach(() => {
    store = new InMemoryStore();
    broker = new PermissionBroker(store);
  });

  it('refuses every action while the profile has computer use off', () => {
    for (const p of [policy({ computer: false }), policy({ computer: undefined })]) {
      expect(broker.decide(COMPUTER, { action: 'screenshot', app: null }, p, ctx())).toEqual({ kind: 'deny', reason: 'Computer use is turned off for this profile.' });
      expect(broker.decide(COMPUTER, click(), p, ctx())).toEqual({ kind: 'deny', reason: 'Computer use is turned off for this profile.' });
    }
  });

  it('refuses an unattended run, even with an always grant for the app, and even a screenshot', () => {
    grant(EXCEL);
    const reason = 'Computer use needs someone at the machine; it never runs unattended.';
    expect(broker.decide(COMPUTER, click(), policy(), ctx({ unattended: true }))).toEqual({ kind: 'deny', reason, unattended: true });
    expect(broker.decide(COMPUTER, { action: 'screenshot', app: null }, policy(), ctx({ unattended: true }))).toEqual({ kind: 'deny', reason, unattended: true });
    // The same call with someone there is covered by the grant.
    expect(broker.decide(COMPUTER, click(), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
  });

  it('counts anything but a plain false or nothing as unattended', () => {
    grant(EXCEL);
    const reason = 'Computer use needs someone at the machine; it never runs unattended.';
    for (const unattended of ['true', 'false', 1, 0, {}, [], null, 'yes']) {
      const odd = ctx({ unattended: unattended as unknown as boolean });
      expect(broker.decide(COMPUTER, click(), policy(), odd), JSON.stringify(unattended)).toEqual({ kind: 'deny', reason, unattended: true });
      expect(broker.decide(COMPUTER, { action: 'screenshot' }, policy(), odd), JSON.stringify(unattended)).toEqual({ kind: 'deny', reason, unattended: true });
    }
    for (const attended of [undefined, false]) {
      expect(broker.decide(COMPUTER, click(), policy(), ctx({ unattended: attended }))).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    }
  });

  it('lets a screenshot, the cursor position and a wait through with no card, in both approval modes', () => {
    for (const approvalMode of ['always_ask', 'ask_on_mutate'] as const) {
      for (const action of ['screenshot', 'cursor_position', 'wait']) {
        expect(broker.decide(COMPUTER, { action, app: null }, policy({ approvalMode }), ctx())).toEqual({ kind: 'allow', grantedBy: 'policy' });
      }
    }
    // A wait longer than the cap is cut to it; one that is not a length of time is no wait.
    expect(broker.decide(COMPUTER, { action: 'wait', duration: 1e9 }, policy(), ctx())).toEqual({ kind: 'allow', grantedBy: 'policy' });
    for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, -1, '5', {}]) {
      expect(broker.decide(COMPUTER, { action: 'wait', duration }, policy(), ctx()), String(duration)).toEqual({ kind: 'deny', reason: "Grunt can't carry out that action as it was sent, so it didn't run it." });
    }
    // An app a look's arguments name changes nothing: it is still only a look.
    expect(broker.decide(COMPUTER, { action: 'screenshot', app: CMD }, policy(), ctx())).toEqual({ kind: 'allow', grantedBy: 'policy' });
    // A look carrying fields it doesn't use is not let through as a look: it is refused like any other call it can't carry out.
    expect(broker.decide(COMPUTER, { action: 'screenshot', coordinate: [1, 2], text: 'x', app: CMD }, policy(), ctx())).toEqual({ kind: 'deny', reason: "Grunt can't carry out that action as it was sent, so it didn't run it." });
  });

  it('never lets an action that is not exactly a known name through, with or without a grant', () => {
    grant(EXCEL);
    const odd: unknown[] = [
      undefined,
      null,
      42,
      true,
      ['screenshot'],
      { action: 'screenshot' },
      { toString: () => 'screenshot' },
      'Screenshot',
      'SCREENSHOT',
      ' screenshot',
      'screenshot ',
      'screenshot\u0000',
      'wait\n',
      'Left_Click',
      'left_click ',
      'left_click_drag',
      'zoom',
      '',
    ];
    for (const action of odd) {
      for (const args of [{ action, app: null }, click(EXCEL, { action })]) {
        const decision = broker.decide(COMPUTER, args, policy(), ctx());
        expect(decision.kind, JSON.stringify(action)).toBe('deny');
      }
    }
    expect(store.grants.list()).toHaveLength(1);
    // What it says back never carries a hidden character it was sent.
    const hostile = broker.decide(COMPUTER, { action: 'evil\u202eaction' }, policy(), ctx());
    expect(hostile).toEqual({ kind: 'deny', reason: '"evilaction" isn\'t a computer action Grunt can do.' });
  });

  it('goes by the action name, not the declared risk', () => {
    const lying: ToolSpec = { ...COMPUTER, risk: 'read' };
    for (const approvalMode of ['always_ask', 'ask_on_mutate'] as const) {
      expect(broker.decide(lying, click(), policy({ approvalMode }), ctx()).kind).toBe('ask');
      expect(broker.decide(lying, click(EXCEL, { action: 'type', text: 'x' }), policy({ approvalMode }), ctx()).kind).toBe('ask');
    }
  });

  it('refuses an action whose app it cannot identify, whatever grants are stored', () => {
    const unidentified: unknown[] = [null, undefined, '', '   ', 42, [EXCEL], 'excel.exe', 'EXCEL', 'C:/Program Files/Microsoft Office/root/Office16/EXCEL.EXE', `${EXCEL}.`, `${EXCEL} `, `${EXCEL}\\`, `\\\\?\\${EXCEL}`, `${EXCEL}::$DATA`, 'C:\\a\\b\u202e.exe'];
    for (const app of unidentified) {
      if (typeof app === 'string') grant(app);
    }
    store.grants.create({ id: 'blanket', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'always', constraint: null, expiresAt: null });
    for (const app of unidentified) {
      expect(broker.decide(COMPUTER, click(EXCEL, { app }), policy(), ctx()), JSON.stringify(app)).toEqual({ kind: 'deny', reason: NO_APP });
    }
    expect(broker.decide(COMPUTER, click(null), policy(), ctx())).toEqual({ kind: 'deny', reason: NO_APP });
  });

  it('refuses a call it cannot bind to one window, whatever grants are stored', () => {
    grant(EXCEL);
    const unpinned = "Grunt couldn't pin down which window that is, so it didn't use it.";
    for (const over of [{ appWindow: undefined }, { appWindow: '' }, { appWindow: 7 }, { appPid: undefined }, { appPid: '4242' }, { appPid: 0 }, { appStarted: undefined }, { appStarted: '' }, { appShellView: undefined }, { appShellView: 'false' }, { appShellView: null }]) {
      expect(broker.decide(COMPUTER, click(EXCEL, over), policy(), ctx()), JSON.stringify(over)).toEqual({ kind: 'deny', reason: unpinned });
    }
    expect(broker.decide(COMPUTER, click(EXCEL), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
  });

  it('refuses an action Grunt would never send, whatever grants are stored: a key combination that leaves the app, a point off the screen', () => {
    grant(EXCEL);
    const never = "Grunt can't carry out that action as it was sent, so it didn't run it.";
    const bad: Record<string, unknown>[] = [
      { action: 'key', text: 'ctrl+Escape' },
      { action: 'key', text: 'alt+Tab' },
      { action: 'key', text: 'super+r' },
      { action: 'key', text: 'ctrl+alt+Delete' },
      { action: 'key', text: 'ctrl+a ctrl+c' },
      { action: 'key', text: 'ctrl+Escape r u n Return' },
      { action: 'key', text: 'XF86Search' },
      { action: 'key', text: 'alt+F4' },
      { action: 'key', text: 'a+b+c+d+e' },
      { action: 'key', text: 's'.repeat(65) },
      { action: 'type', text: 'a'.repeat(4001) },
      { action: 'type', text: `escape ${String.fromCharCode(0x1b)}` },
      { action: 'type', text: `nul ${String.fromCharCode(0)}` },
      { action: 'key', text: undefined },
      { action: 'type', text: '' },
      { action: 'type', text: 42 },
      { action: 'type', text: 'broken \ud83d' },
      { action: 'left_click', coordinate: [1e308, 5] },
      { action: 'left_click', coordinate: [-1, 5] },
      { action: 'left_click', coordinate: '512,300' },
      { action: 'scroll', scroll_direction: 'sideways' },
      { action: 'scroll', scroll_direction: 'down', scroll_amount: 500 },
    ];
    for (const over of bad) {
      expect(broker.decide(COMPUTER, click(EXCEL, over), policy(), ctx()), JSON.stringify(over)).toEqual({ kind: 'deny', reason: never });
    }
    // The same grant does cover what Grunt would send.
    for (const over of [{ action: 'key', text: 'ctrl+s' }, { action: 'type', text: 'hello' }, { action: 'scroll', scroll_direction: 'down' }]) {
      expect(broker.decide(COMPUTER, click(EXCEL, over), policy(), ctx()), JSON.stringify(over)).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    }
  });

  it('names the app on the card from its key alone, never from a name the call carries', () => {
    for (const appName of ['EXCEL', 'Notepad', 'Trusted by Grunt policy', 'cmd\u202e', 42, undefined]) {
      const ask = expectAsk(broker.decide(COMPUTER, click(DOWNLOADED_EXCEL, { appName, appTitle: 'Microsoft Excel (verified)' }), policy(), ctx()));
      expect(ask.request).toMatchObject({ toolName: 'computer', source: 'computer', summary: 'Use EXCEL.EXE: click at 512, 300' });
    }
    expect(expectAsk(broker.decide(COMPUTER, click(NOTEPAD), policy(), ctx())).request.summary).toBe('Use notepad.exe: click at 512, 300');
    expect(expectAsk(broker.decide(COMPUTER, click('C:\\Apps\\caf\u00e9.exe'), policy(), ctx())).request.summary).toBe('Use caf\u00e9.exe: click at 512, 300');
    // A very long file name is cut, never wrapped over the card.
    const long = expectAsk(broker.decide(COMPUTER, click(`C:\\Apps\\${'n'.repeat(200)}.exe`), policy(), ctx())).request.summary;
    expect(long).toBe(`Use ${'n'.repeat(80)}\u2026: click at 512, 300`);
  });

  it('a chat answer stores a grant for exactly that app', () => {
    const ask = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    broker.resolve(ask.request.id, { choice: 'chat' });
    const grants = store.grants.list();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ chatId: 'chat-1', profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'chat' });
    expect(grants[0]?.constraint).toEqual({ app: EXCEL });

    expect(broker.decide(COMPUTER, click(EXCEL, { coordinate: [10, 10] }), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(broker.decide(COMPUTER, click(EXCEL, { appWindow: 'hwnd-2', appName: 'x' }), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(broker.decide(COMPUTER, click(), policy(), ctx({ chatId: 'chat-2' })).kind).toBe('ask');
    expect(broker.decide(COMPUTER, click(), policy(), ctx({ profileId: 'profile-2' })).kind).toBe('ask');
  });

  it("never lets one app's grant cover a path that is only nearly the same", () => {
    grant(EXCEL);
    grant(EXCEL, { chatId: 'chat-1', scope: 'chat' });
    const nearly = [
      DOWNLOADED_EXCEL,
      EXCEL.toLowerCase(),
      EXCEL.toUpperCase(),
      'c:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE.',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE ',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE\\',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\\\EXCEL.EXE',
      'C:/Program Files/Microsoft Office/root/Office16/EXCEL.EXE',
      'C:\\PROGRA~1\\MICROS~1\\root\\Office16\\EXCEL.EXE',
      '\\\\?\\C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
      '\\\\.\\C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
      '\\\\localhost\\c$\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\.\\EXCEL.EXE',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\x\\..\\EXCEL.EXE',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE\u00a0',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE\u200b',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCE\u212a.EXE',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE:stream',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL',
      'C:\\Program Files\\Microsoft Office\\root\\Office16',
      'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE\\more.exe',
      'D:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE',
    ];
    for (const app of nearly) {
      expect(broker.decide(COMPUTER, click(app), policy(), ctx()).kind, JSON.stringify(app)).not.toBe('allow');
    }
    expect(broker.decide(COMPUTER, click(EXCEL), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
  });

  it('needs an app on an always answer', () => {
    const first = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    expect(() => broker.resolve(first.request.id, { choice: 'always', constraint: null })).toThrow(/computer use/);
    const empty = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    expect(() => broker.resolve(empty.request.id, { choice: 'always', constraint: {} })).toThrow(/computer use/);
    expect(store.grants.list()).toEqual([]);
    const second = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    broker.resolve(second.request.id, { choice: 'always', constraint: { app: EXCEL } });
    expect(store.grants.list()[0]).toMatchObject({ scope: 'always', chatId: null, constraint: { app: EXCEL } });
    expect(broker.decide(COMPUTER, click(), policy(), ctx({ chatId: 'chat-9' }))).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
  });

  it('refuses an always answer that names another app than the card asked about, or the same one spelled another way', () => {
    for (const other of [DOWNLOADED_EXCEL, EXCEL.toLowerCase(), 'C:/Program Files/Microsoft Office/root/Office16/EXCEL.EXE', `${EXCEL} `, 'EXCEL.EXE', '']) {
      const ask = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
      expect(() => broker.resolve(ask.request.id, { choice: 'always', constraint: { app: other } }), JSON.stringify(other)).toThrow(/computer use/);
    }
    const ask = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    expect(() => broker.resolve(ask.request.id, { choice: 'always', constraint: { app: DOWNLOADED_EXCEL } })).toThrow(
      `Refusing an "always" grant for computer use that doesn't name the app the card asked about (${EXCEL}).`
    );
    expect(store.grants.list()).toEqual([]);
    expect(broker.decide(COMPUTER, click(DOWNLOADED_EXCEL), policy(), ctx()).kind).toBe('ask');
  });

  it("stores an always answer only as exactly the card's app: one that carries anything else is refused and stores nothing", () => {
    // Integration (cowork-parity step 5): an "always" is held to the same rule as the host-keyed ones
    // (alwaysConstraintFor): exactly one key, the card's own. The provider denies a computer call whose
    // answer the broker refuses (ruling 8), so a card that sent more runs nothing.
    const ask = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    expect(() => broker.resolve(ask.request.id, { choice: 'always', constraint: { app: EXCEL, commandExact: 'x', pathPrefix: '/', host: 'example.com' } })).toThrow(
      /names anything but the card's own app/
    );
    expect(store.grants.list()).toEqual([]);
    const again = expectAsk(broker.decide(COMPUTER, click(), policy(), ctx()));
    broker.resolve(again.request.id, { choice: 'always', constraint: { app: EXCEL } });
    const grants = store.grants.list();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ scope: 'always', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer' });
    expect(grants[0]?.constraint).toEqual({ app: EXCEL });
  });

  it('ignores a stored computer grant that names no app, or an app that is not a valid key', () => {
    store.grants.create({ id: 'blanket', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'always', constraint: null, expiresAt: null });
    store.grants.create({ id: 'other-key', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'computer', scope: 'always', constraint: { commandExact: 'x' }, expiresAt: null });
    for (const app of ['', 'EXCEL.EXE', 'C:/Program Files/Microsoft Office/root/Office16/EXCEL.EXE', `${EXCEL}.`, `${EXCEL} `, 42, null, ['x']]) grant(app);
    expect(broker.decide(COMPUTER, click(), policy(), ctx()).kind).toBe('ask');
    expect(broker.decide(COMPUTER, click(EXCEL.toLowerCase()), policy(), ctx()).kind).toBe('ask');
  });

  it('never lets a computer grant with anything beside its app match by the other key', () => {
    // Each names Excel AND carries a second key that a click on Notepad can be made to satisfy.
    const beside: Record<string, unknown>[] = [{ commandExact: 'x' }, { commandPrefix: 'x' }, { host: 'example.com' }, { pathPrefix: '/' }];
    for (const extra of beside) grant(EXCEL, { constraint: { app: EXCEL, ...extra } });
    // A call can't carry the other key's fields at all: a click with them is refused before any grant is looked at.
    const riding = { command: 'x', host: 'example.com', path: '/' };
    for (const app of [NOTEPAD, DOWNLOADED_EXCEL, EXCEL]) expect(broker.decide(COMPUTER, click(app, riding), policy(), ctx()).kind).toBe('deny');
    expect(broker.decide(COMPUTER, click(NOTEPAD), policy(), ctx()).kind).toBe('ask');
    expect(broker.decide(COMPUTER, click(DOWNLOADED_EXCEL), policy(), ctx()).kind).toBe('ask');
    // Nor do they cover Excel itself: a grant that is not exactly one app is no grant.
    expect(broker.decide(COMPUTER, click(EXCEL), policy(), ctx()).kind).toBe('ask');
    grant(EXCEL);
    expect(broker.decide(COMPUTER, click(EXCEL), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(broker.decide(COMPUTER, click(NOTEPAD), policy(), ctx()).kind).toBe('ask');
  });

  it('refuses to store anything when the call no longer names a valid app by the time it is answered', () => {
    for (const choice of [{ choice: 'chat' as const }, { choice: 'always' as const, constraint: { app: EXCEL } }, { choice: 'always' as const, constraint: { app: 'excel.exe' } }]) {
      const args = click();
      const ask = expectAsk(broker.decide(COMPUTER, args, policy(), ctx()));
      args['app'] = 'excel.exe';
      expect(() => broker.resolve(ask.request.id, choice), JSON.stringify(choice)).toThrow(/computer use/);
    }
    expect(store.grants.list()).toEqual([]);
  });

  it('only ever allows a high-risk app once: a chat or always answer is refused and stores nothing', () => {
    for (const choice of [{ choice: 'chat' as const }, { choice: 'always' as const, constraint: { app: CMD } }]) {
      const ask = expectAsk(broker.decide(COMPUTER, click(CMD), policy(), ctx()));
      expect(() => broker.resolve(ask.request.id, choice), choice.choice).toThrow('Refusing to store a grant for computer use of cmd.exe: Grunt asks every time for this app.');
      expect(broker.hasPending(ask.request.id)).toBe(false);
    }
    expect(store.grants.list()).toEqual([]);
    // Allow once and Deny are ordinary answers.
    const once = expectAsk(broker.decide(COMPUTER, click(CMD), policy(), ctx()));
    broker.resolve(once.request.id, { choice: 'once' });
    const deny = expectAsk(broker.decide(COMPUTER, click(CMD), policy(), ctx()));
    broker.resolve(deny.request.id, { choice: 'deny' });
    expect(store.grants.list()).toEqual([]);
  });

  it('never matches a stored grant for a high-risk app', () => {
    for (const app of [CMD, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Users\\a\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'C:\\Python312\\python3.12.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERS~1.EXE']) {
      grant(app);
      grant(app, { chatId: 'chat-1', scope: 'chat' });
      // Whatever the call claims about its own risk.
      for (const appRisk of ['high', 'normal', undefined]) {
        expect(broker.decide(COMPUTER, click(app, { appRisk }), policy(), ctx()).kind, `${app} ${String(appRisk)}`).toBe('ask');
      }
    }
  });

  it('treats an app as high-risk unless the call is provably ordinary', () => {
    // The tool marked it high-risk though its name is on no list (a console program, an unsigned one...).
    // The risk is missing or is not one of the two words.
    for (const appRisk of ['high', undefined, 'HIGH', 'unknown', null, true]) {
      const odd = 'C:\\Tools\\admin-console.exe';
      grant(odd);
      expect(broker.decide(COMPUTER, click(odd, { appRisk }), policy(), ctx()).kind, String(appRisk)).toBe('ask');
      for (const choice of [{ choice: 'chat' as const }, { choice: 'always' as const, constraint: { app: odd } }]) {
        const ask = expectAsk(broker.decide(COMPUTER, click(odd, { appRisk }), policy(), ctx()));
        expect(() => broker.resolve(ask.request.id, choice)).toThrow(/asks every time/);
      }
    }
    expect(store.grants.list().every((g) => g.id.startsWith('g'))).toBe(true);
    expect(store.grants.list()).toHaveLength(6);
  });

  it("asks every time in an ordinary app's file dialog: the app's grant does not reach it, and no answer stores one", () => {
    const classify = (over: Parameters<typeof fakeComputerTarget>[0]): Record<string, unknown> => {
      const classified = classifyTarget(fakeComputerTarget({ path: NOTEPAD, originalName: 'NOTEPAD.EXE', ...over }));
      if (classified.kind !== 'app') throw new Error(classified.reason);
      return { action: 'left_click', coordinate: [512, 300], ...appArgs(classified) };
    };
    grant(NOTEPAD);
    grant(NOTEPAD, { chatId: 'chat-1', scope: 'chat' });
    // The main window is covered by the grant.
    expect(broker.decide(COMPUTER, classify({}), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    // Its Open dialog is the same program, and is asked about.
    const dialog = classify({ shellView: true, title: 'Open', windowId: 'hwnd-dialog' });
    const ask = expectAsk(broker.decide(COMPUTER, dialog, policy(), ctx()));
    expect(ask.request.summary).toBe('Use notepad.exe: click at 512, 300');
    expect(() => broker.resolve(ask.request.id, { choice: 'chat' })).toThrow(/asks every time/);
    const again = expectAsk(broker.decide(COMPUTER, dialog, policy(), ctx()));
    expect(() => broker.resolve(again.request.id, { choice: 'always', constraint: { app: NOTEPAD } })).toThrow(/asks every time/);
    expect(store.grants.list()).toHaveLength(2);
  });

  it('never matches a grant for described arguments that say the window is a file view, whatever risk they claim', () => {
    grant(EXCEL);
    grant(EXCEL, { chatId: 'chat-1', scope: 'chat' });
    const fileView = click(EXCEL, { appShellView: true, appRisk: 'normal' });
    expect(broker.decide(COMPUTER, fileView, policy(), ctx()).kind).toBe('ask');
    for (const choice of [{ choice: 'chat' as const }, { choice: 'always' as const, constraint: { app: EXCEL } }]) {
      const ask = expectAsk(broker.decide(COMPUTER, fileView, policy(), ctx()));
      expect(() => broker.resolve(ask.request.id, choice)).toThrow(/asks every time/);
    }
    expect(store.grants.list()).toHaveLength(2);
    expect(broker.decide(COMPUTER, click(EXCEL), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
  });

  it('never puts typed text in the card line: only how much of it there is', () => {
    const text = `${'a'.repeat(45)}\nhunter2`;
    const ask = expectAsk(broker.decide(COMPUTER, click(EXCEL, { action: 'type', text }), policy(), ctx()));
    expect(ask.request.summary).toBe('Use EXCEL.EXE: type 53 characters (2 lines)');
    expect(ask.request.summary).not.toContain('hunter2');
    const key = expectAsk(broker.decide(COMPUTER, click(EXCEL, { action: 'key', text: 'S+CTRL' }), policy(), ctx()));
    expect(key.request.summary).toBe('Use EXCEL.EXE: press ctrl+s');
  });

  it("never lets another source's grant stand in for computer use", () => {
    store.grants.create({ id: 'mcp', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'mcp', scope: 'always', constraint: { app: EXCEL }, expiresAt: null });
    store.grants.create({ id: 'browser', chatId: null, profileId: 'profile-1', toolName: 'computer', source: 'browser', scope: 'always', constraint: { host: 'example.com', app: EXCEL }, expiresAt: null });
    expect(broker.decide(COMPUTER, click(), policy(), ctx()).kind).toBe('ask');
  });
});

describe('the app grant beside the host and live grants (cowork-parity integration)', () => {
  let store: InMemoryStore;
  let broker: PermissionBroker;
  const BROWSER: ToolSpec = { name: 'browser', description: '', parameters: {}, risk: 'mutate', source: 'browser', execute: async () => null };
  const NETWORK: ToolSpec = { name: 'sandbox_network', description: '', parameters: {}, risk: 'mutate', source: 'network', execute: async () => null };
  const WRITE: ToolSpec = { name: 'write_file', description: '', parameters: {}, risk: 'mutate', source: 'fs', execute: async () => null };
  const wide = (): ToolPolicy => ({ fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'ask_on_mutate', browser: true, computer: true });
  const open = { command: 'open', url: 'https://example.com/', host: 'example.com' };
  const row = (id: string, toolName: string, source: Grant['source'], constraint: Grant['constraint']): void => {
    store.grants.create({ id, chatId: null, profileId: 'profile-1', toolName, source, scope: 'always', constraint, expiresAt: null });
  };

  beforeEach(() => {
    store = new InMemoryStore();
    broker = new PermissionBroker(store);
  });

  it('never lets an app grant cover a browser, network or file call, nor a host grant a computer call, whatever the rows say', () => {
    row('b-app', 'browser', 'browser', { app: EXCEL });
    row('n-app', 'sandbox_network', 'network', { app: EXCEL });
    row('c-host', 'computer', 'computer', { host: 'example.com' });
    row('c-both', 'computer', 'computer', { app: EXCEL, host: 'example.com' });
    row('b-both', 'browser', 'browser', { host: 'example.com', app: EXCEL });
    row('c-live', 'computer', 'computer', { app: EXCEL, live: { artifactId: 'a', callId: 'c', hash: 'h', serverId: 's' } });
    expect(broker.decide(BROWSER, open, wide(), ctx({ workspaceRoot: '/ws' })).kind).toBe('ask');
    expect(broker.decide(NETWORK, { host: 'example.com' }, wide(), ctx({ workspaceRoot: '/ws' })).kind).toBe('ask');
    expect(broker.decide(COMPUTER, click(), wide(), ctx()).kind).toBe('ask');
    // The plain ones each cover their own source only.
    row('c-ok', 'computer', 'computer', { app: EXCEL });
    row('b-ok', 'browser', 'browser', { host: 'example.com' });
    expect(broker.decide(COMPUTER, click(), wide(), ctx())).toMatchObject({ kind: 'allow', grantId: 'c-ok' });
    expect(broker.decide(BROWSER, open, wide(), ctx({ workspaceRoot: '/ws' }))).toMatchObject({ kind: 'allow', grantId: 'b-ok' });
    expect(broker.decide(NETWORK, { host: 'example.com' }, wide(), ctx({ workspaceRoot: '/ws' })).kind).toBe('ask');
  });

  it("stores a chat answer for computer use as exactly { app }, and refuses an 'always' of another kind on either side", () => {
    const chat = expectAsk(broker.decide(COMPUTER, click(), wide(), ctx()));
    broker.resolve(chat.request.id, { choice: 'chat' });
    expect(store.grants.list().map((g) => g.constraint)).toEqual([{ app: EXCEL }]);
    store.grants.delete(store.grants.list()[0]!.id);
    // A host on a computer card, an app on a browser, network or file card: refused, nothing stored.
    const computerAsk = expectAsk(broker.decide(COMPUTER, click(), wide(), ctx()));
    expect(() => broker.resolve(computerAsk.request.id, { choice: 'always', constraint: { host: 'example.com' } })).toThrow();
    const browserAsk = expectAsk(broker.decide(BROWSER, open, wide(), ctx({ workspaceRoot: '/ws' })));
    expect(() => broker.resolve(browserAsk.request.id, { choice: 'always', constraint: { app: EXCEL } })).toThrow();
    const networkAsk = expectAsk(broker.decide(NETWORK, { host: 'example.com' }, wide(), ctx({ workspaceRoot: '/ws' })));
    expect(() => broker.resolve(networkAsk.request.id, { choice: 'always', constraint: { host: 'example.com', app: EXCEL } })).toThrow();
    const writeAsk = expectAsk(broker.decide(WRITE, { path: 'a.txt' }, wide(), ctx({ workspaceRoot: '/ws' })));
    expect(() => broker.resolve(writeAsk.request.id, { choice: 'always', constraint: { app: EXCEL } })).toThrow(/only a pathPrefix/);
    expect(store.grants.list()).toEqual([]);
  });

  it('never lets computer use feed a live artifact: not eligible, no live grant made, and a live context is refused', () => {
    expect(broker.liveIneligibility(COMPUTER, wide())).toBe('Only MCP tools can feed a live artifact.');
    expect(() =>
      broker.grantLive({ chatId: 'chat-1', profileId: 'profile-1', artifactId: 'a', policy: wide(), calls: [{ tool: COMPUTER, callId: 'c', hash: 'h', serverId: 's' }] })
    ).toThrow(/Only MCP tools/);
    const live = { artifactId: 'a', callId: 'c', hash: 'h', serverId: 's' };
    expect(broker.decide(COMPUTER, { action: 'screenshot', app: null }, wide(), ctx({ live }))).toMatchObject({ kind: 'deny' });
    expect(store.grants.list()).toEqual([]);
  });
});
