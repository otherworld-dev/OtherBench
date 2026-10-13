import { describe, expect, it } from 'vitest';
import {
  actionSummary,
  SHORTCUTS_UNKNOWN_REASON,
  APP_ARG_FIELDS,
  appArgs,
  appKey,
  classifyTarget,
  COMPUTER_ACTIONS,
  COMPUTER_LIMITS,
  coordinateOf,
  describeApp,
  describedCallArgs,
  expectationOf,
  HIGH_RISK_FAMILIES,
  HIGH_RISK_STEMS,
  isComputerAction,
  isHighRiskApp,
  isHighRiskProgramName,
  isReadAction,
  isUnattendedRun,
  parseAction,
  pathForCard,
  READ_ACTIONS,
  typedTextForCard,
  windowTitleForCard,
  type ClassifiedTarget,
} from '../src/domain/computer-apps.js';
import { isWellFormedText } from '../src/domain/card-text.js';

const EXCEL = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE';
const DOWNLOADED_EXCEL = 'C:\\Users\\Adam\\Downloads\\EXCEL.EXE';
const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';

/** A fully populated, signed, fixed-disk Notepad: the one kind of target that is ordinary. */
function target(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: NOTEPAD,
    originalName: 'NOTEPAD.EXE',
    signer: 'Microsoft Windows',
    console: false,
    location: 'fixed',
    elevated: false,
    uiAccess: false,
    grunt: false,
    shellView: false,
    title: 'Untitled - Notepad',
    windowId: 'hwnd-1',
    pid: 4242,
    startedAt: '2026-10-12T09:00:00.000Z',
    ...over,
  };
}

function without(field: string): Record<string, unknown> {
  const t = target();
  delete t[field];
  return t;
}

function app(classified: ClassifiedTarget): Extract<ClassifiedTarget, { kind: 'app' }> {
  if (classified.kind !== 'app') throw new Error(`Expected an app, got a refusal: ${classified.reason}`);
  return classified;
}

function refusal(classified: ClassifiedTarget): string {
  if (classified.kind !== 'refuse') throw new Error(`Expected a refusal, got ${JSON.stringify(classified)}`);
  return classified.reason;
}

describe('the app key', () => {
  it('is the path the shell resolved, unchanged, or nothing', () => {
    for (const valid of [EXCEL, '\\\\server\\share\\App.exe', NOTEPAD, 'D:\\x.exe', 'C:\\Users\\Jos\u00e9\\AppData\\Local\\App\\app.exe']) expect(appKey(valid)).toBe(valid);
  });

  it('never repairs a path: anything that is not already canonical is no key at all', () => {
    const bad: unknown[] = [
      '',
      '   ',
      42,
      null,
      undefined,
      ['C:\\a\\b.exe'],
      'cmd.exe',
      'C:cmd.exe',
      'C:\\',
      'C:/Tools/App.exe',
      'C:\\Tools/App.exe',
      'C:\\Tools\\\\App.exe',
      '  D:\\x.exe ',
      'C:\\a\\.\\b.exe',
      'C:\\a\\..\\b.exe',
      'C:\\a\\b.exe.',
      'C:\\a\\b.exe ',
      'C:\\a \\b.exe',
      'C:\\a.\\b.exe',
      'C:\\a\\b.exe\\',
      'C:\\a\\b.exe::$DATA',
      'C:\\a\\b.exe:s',
      'C:\\a\\b*.exe',
      'C:\\a\\b?.exe',
      'C:\\a\\"b".exe',
      'C:\\a\\b|c.exe',
      'C:\\a\\<b>.exe',
      '\\\\?\\C:\\a\\b.exe',
      '\\\\.\\C:\\a\\b.exe',
      '\\??\\C:\\a\\b.exe',
      '\\\\?\\UNC\\s\\sh\\b.exe',
      '\\Device\\HarddiskVolume3\\a\\b.exe',
      '\\\\server\\share',
      '\\\\server\\b.exe',
      '\\\\\\server\\share\\b.exe',
      '\\a\\b.exe',
      '1:\\a\\b.exe',
      'C:\\a\\b\u202e.exe',
      'C:\\a\\b\u200b.exe',
      'C:\\a\\b\ufffd.exe',
      'C:\\a\\b\u0000.exe',
      'C:\\a\\b\n.exe',
      'C:\\a\\b\ud800.exe',
      '\ufeffC:\\x\\app.exe',
      `C:\\${'a'.repeat(1018)}.exe`,
    ];
    expect(`C:\\${'a'.repeat(1018)}.exe`).toHaveLength(1025);
    expect(appKey(`C:\\${'a'.repeat(1017)}.exe`)).not.toBeNull();
    for (const raw of bad) expect(appKey(raw), JSON.stringify(raw)).toBeNull();
  });

  it('keeps apart every pair of files the file system keeps apart', () => {
    const pairs: [string, string][] = [
      ['C:\\cs\\Tool.exe', 'C:\\cs\\tool.exe'],
      ['C:\\Users\\a\\AppData\\Local\\slack\\slack.exe', 'C:\\Users\\a\\AppData\\Local\\slac\u212a\\slack.exe'],
      ['C:\\a\\\u00c5.exe', 'C:\\a\\\u212b.exe'],
      ['C:\\a\\caf\u00e9.exe', 'C:\\a\\cafe\u0301.exe'],
      ['C:\\a\\app.exe', 'C:\\a\\app.exe\u00a0'],
      [DOWNLOADED_EXCEL, EXCEL],
    ];
    for (const [one, other] of pairs) {
      expect(appKey(one)).toBe(one);
      expect(appKey(other)).toBe(other);
      expect(appKey(one)).not.toBe(appKey(other));
    }
  });
});

describe('what a card says about an app', () => {
  it('takes the name and the path from the key, and nothing else', () => {
    expect(describeApp(EXCEL)).toEqual({ key: EXCEL, name: 'EXCEL.EXE', path: EXCEL, unusual: false });
    expect(describeApp(DOWNLOADED_EXCEL)).toEqual({ key: DOWNLOADED_EXCEL, name: 'EXCEL.EXE', path: DOWNLOADED_EXCEL, unusual: false });
    expect(describeApp('\\\\server\\share\\App.exe')).toEqual({ key: '\\\\server\\share\\App.exe', name: 'App.exe', path: '\\\\server\\share\\App.exe', unusual: false });
    for (const bad of ['EXCEL', 'C:/x.exe', '', null, 42, undefined]) expect(describeApp(bad)).toBeNull();
  });

  it('says when a file name has characters that can pass for others', () => {
    // Cyrillic o in "Code.exe"; a no-break space after ".exe".
    expect(describeApp('C:\\Programs\\Microsoft VS Code\\C\u043ede.exe')?.unusual).toBe(true);
    expect(describeApp('C:\\a\\app.exe\u00a0')?.unusual).toBe(true);
    expect(describeApp('C:\\Users\\Jos\u00e9\\AppData\\Local\\App\\app.exe')?.unusual).toBe(true);
  });

  it('spells out hidden characters in a path it was handed from elsewhere', () => {
    expect(pathForCard('C:\\a\\b\u202e.exe')).toBe('C:\\a\\b<U+202E>.exe');
    expect(pathForCard('C:\\a\\b\u200b.exe\n')).toBe('C:\\a\\b<U+200B>.exe<U+000A>');
    expect(pathForCard(EXCEL)).toBe(EXCEL);
    expect(pathForCard(42)).toBe('');
  });

  it('makes a window title one bounded line', () => {
    expect(windowTitleForCard('Approved\nby policy\u202e')).toBe('Approved by policy');
    expect(windowTitleForCard('t'.repeat(500))).toBe(`${'t'.repeat(80)}\u2026`);
    for (const bad of [undefined, null, 42, {}]) expect(windowTitleForCard(bad)).toBe('');
  });
});

describe('classifying a target', () => {
  it('finds only a fully described, signed program on a fixed disk ordinary', () => {
    expect(classifyTarget(target())).toEqual({
      kind: 'app',
      key: NOTEPAD,
      name: 'notepad.exe',
      title: 'Untitled - Notepad',
      risk: 'normal',
      shellView: false,
      windowId: 'hwnd-1',
      pid: 4242,
      startedAt: '2026-10-12T09:00:00.000Z',
    });
    // An image with no version resource at all, when it is signed.
    expect(app(classifyTarget(target({ path: 'C:\\Tools\\thing.exe', originalName: null }))).risk).toBe('normal');
  });

  it('never calls a malformed target ordinary', () => {
    const malformed: unknown[] = [
      {},
      null,
      undefined,
      'C:\\Windows\\System32\\notepad.exe',
      42,
      [target()],
      without('originalName'),
      without('signer'),
      without('console'),
      without('location'),
      without('elevated'),
      without('uiAccess'),
      without('grunt'),
      without('title'),
      without('windowId'),
      without('pid'),
      without('startedAt'),
      without('path'),
      target({ elevated: undefined }),
      target({ grunt: 'no' }),
      target({ grunt: 0 }),
      target({ uiAccess: null }),
      target({ console: 'false' }),
      target({ location: 'network' }),
      target({ location: 'removable' }),
      target({ location: 'unknown' }),
      target({ location: 'FIXED' }),
      target({ originalName: 42 }),
      target({ signer: null }),
      target({ signer: '' }),
      target({ signer: 42 }),
      target({ title: 42 }),
      target({ pid: '4242' }),
      target({ pid: 0 }),
      target({ pid: 1.5 }),
      target({ windowId: '' }),
      target({ windowId: 7 }),
      target({ startedAt: '' }),
      target({ startedAt: 1760000000 }),
      target({ path: 'notepad.exe' }),
      target({ path: 'C:/Windows/System32/notepad.exe' }),
    ];
    for (const t of malformed) {
      const classified = classifyTarget(t);
      expect(classified.kind === 'app' && classified.risk === 'normal', JSON.stringify(t)).toBe(false);
    }
  });

  it("refuses Grunt's own windows, elevated programs and ones with UI access", () => {
    expect(refusal(classifyTarget(target({ grunt: true })))).toBe("That's Grunt's own window. Grunt never controls itself.");
    expect(refusal(classifyTarget(target({ elevated: true })))).toBe("notepad.exe is running as administrator, so Grunt can't control it.");
    expect(refusal(classifyTarget(target({ uiAccess: true })))).toBe("notepad.exe can control other apps (UI access), so Grunt doesn't control it.");
    // A second Grunt, which the shell's own process check would miss.
    for (const path of ['C:\\Program Files\\Grunt\\grunt-desktop.exe', 'C:\\Program Files\\Grunt\\Grunt.exe', 'D:\\copy\\GRUNT-DESKTOP.EXE']) {
      expect(refusal(classifyTarget(target({ path, originalName: null, grunt: false })))).toBe("That's Grunt's own window. Grunt never controls itself.");
    }
    expect(refusal(classifyTarget(target({ path: 'C:\\Users\\a\\Desktop\\notes.exe', originalName: 'grunt-desktop.exe' })))).toBe("That's Grunt's own window. Grunt never controls itself.");
  });

  it('refuses a target it cannot check or cannot pin to one window', () => {
    const unchecked = "Grunt couldn't check what kind of window that is, so it didn't use it.";
    for (const over of [{ grunt: 'no' }, { grunt: undefined }, { elevated: undefined }, { elevated: 'false' }, { uiAccess: null }]) {
      expect(refusal(classifyTarget(target(over))), JSON.stringify(over)).toBe(unchecked);
    }
    const unpinned = "Grunt couldn't pin down which window that is, so it didn't use it.";
    for (const over of [{ windowId: '' }, { windowId: 7 }, { windowId: 'w\u202e' }, { windowId: 'w'.repeat(200) }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: '1' }, { startedAt: '' }, { startedAt: 5 }]) {
      expect(refusal(classifyTarget(target(over))), JSON.stringify(over)).toBe(unpinned);
    }
    const noApp = "Grunt couldn't tell which app this action would use, so it didn't run it.";
    for (const t of [{}, null, 'x', target({ path: 'notepad.exe' }), target({ path: 'C:\\a\\b\u202e.exe' }), without('path')]) {
      expect(refusal(classifyTarget(t)), JSON.stringify(t)).toBe(noApp);
    }
  });

  it("passes the shell's own refusal on, as one clean line", () => {
    expect(refusal(classifyTarget({ refuse: 'No window\nthere\u202e.' }))).toBe('No window there.');
    expect(refusal(classifyTarget({ refuse: '', path: NOTEPAD }))).toBe("Grunt couldn't tell which app this action would use, so it didn't run it.");
    expect(refusal(classifyTarget({ ...target(), refuse: 'nope' }))).toBe('nope');
  });

  it('asks every time for a renamed shell, by the name the program was built with', () => {
    expect(app(classifyTarget(target({ path: 'C:\\Users\\a\\Desktop\\notcmd.exe', originalName: 'Cmd.Exe' }))).risk).toBe('high');
    expect(app(classifyTarget(target({ path: 'C:\\Users\\a\\Desktop\\tool.exe', originalName: 'PowerShell.EXE.MUI' }))).risk).toBe('high');
    expect(app(classifyTarget(target({ path: 'C:\\Users\\a\\Desktop\\tool.exe', originalName: 'electron.exe' }))).risk).toBe('high');
    expect(app(classifyTarget(target({ path: 'C:\\Users\\a\\Desktop\\tool.exe', originalName: 'pwsh' }))).risk).toBe('high');
    expect(app(classifyTarget(target({ path: 'C:\\Users\\a\\Desktop\\tool.exe', originalName: 'c\u043cd.exe' }))).risk).toBe('high');
  });

  it('asks every time for a short (8.3) path, a console program, a program off a fixed disk and an unsigned one', () => {
    const high: Record<string, unknown>[] = [
      { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERS~1.EXE', originalName: null },
      { path: 'C:\\PROGRA~1\\App\\app.exe', originalName: null },
      { path: 'C:\\Python312\\python.exe', originalName: 'python.exe', console: true },
      { path: 'C:\\Tools\\mytool.exe', originalName: null, console: true },
      { location: 'network' },
      { path: '\\\\server\\share\\App.exe', originalName: null, location: 'network' },
      { location: 'removable' },
      { location: 'unknown' },
      { signer: null },
      { originalName: undefined },
      { title: 42 },
      { path: 'C:\\Tools\\thing.scr', originalName: null },
      { path: 'C:\\Tools\\thing.com', originalName: null },
      { path: 'C:\\Tools\\thing', originalName: null },
      { path: 'C:\\Programs\\Microsoft VS Code\\C\u043ede.exe', originalName: null },
      { path: 'C:\\a\\app.exe\u00a0', originalName: null },
    ];
    for (const over of high) expect(app(classifyTarget(target(over))).risk, JSON.stringify(over)).toBe('high');
  });

  it('sanitises the title it hands on, and describes the call from the classification alone', () => {
    const classified = app(classifyTarget(target({ path: EXCEL, originalName: 'Excel.exe', title: 'Book1\n- Approved by Grunt\u202e' })));
    expect(classified.title).toBe('Book1 - Approved by Grunt');
    expect(appArgs(classified)).toEqual({
      app: EXCEL,
      appName: 'EXCEL.EXE',
      appTitle: 'Book1 - Approved by Grunt',
      appRisk: 'normal',
      appShellView: false,
      appWindow: 'hwnd-1',
      appPid: 4242,
      appStarted: '2026-10-12T09:00:00.000Z',
    });
    expect(Object.keys(appArgs(classified)).sort()).toEqual([...APP_ARG_FIELDS].sort());
    expect(Object.isFrozen(APP_ARG_FIELDS)).toBe(true);
  });
});

describe('the high-risk list', () => {
  it('holds shells, script hosts, shell surfaces, admin tools, remote clients, password managers, browsers and IDEs', () => {
    const names = [
      // The original list.
      'cmd.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe', 'conhost.exe', 'openconsole.exe', 'wsl.exe', 'wslhost.exe',
      'bash.exe', 'mintty.exe', 'explorer.exe', 'systemsettings.exe', 'regedit.exe', 'mmc.exe', 'taskmgr.exe', 'control.exe', 'rundll32.exe',
      // What the name-only list let through.
      'powershell_ise.exe', 'wscript.exe', 'cscript.exe', 'mshta.exe', 'msiexec.exe', 'mstsc.exe', 'git-bash.exe', 'alacritty.exe', 'code.exe',
      'dllhost.exe', 'consent.exe', 'CredentialUIBroker.exe', 'LogonUI.exe', 'perfmon.exe', 'SystemPropertiesAdvanced.exe', 'osk.exe',
      'ApplicationFrameHost.exe', 'StartMenuExperienceHost.exe', 'SearchHost.exe', 'python.exe', 'node.exe', 'ssh.exe', 'ftp.exe',
      // Families.
      'python3.12.exe', 'pythonw.exe', 'ubuntu2204.exe', 'conemu64.exe', 'ConEmuC.exe', 'SystemPropertiesProtection.exe',
      // Remote and VM clients, password managers.
      'msrdc.exe', 'vmconnect.exe', 'VirtualBoxVM.exe', 'AnyDesk.exe', 'TeamViewer.exe', '1Password.exe', 'KeePassXC.exe', 'Bitwarden.exe',
      // Browsers and IDEs with terminals.
      'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'Arc.exe', 'Code.exe', 'Cursor.exe', 'devenv.exe',
      'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'clion64.exe', 'goland64.exe', 'idea.exe', 'studio64.exe',
      // Grunt itself.
      'grunt-desktop.exe', 'Grunt.exe',
    ];
    for (const name of names) expect(isHighRiskProgramName(name), name).toBe(true);
  });

  it('counts a name it cannot vouch for as high-risk: no .exe, odd endings, unusual characters, a short name', () => {
    for (const name of ['cmd', 'cmd.exe.', 'cmd.exe ', 'cmd.com', 'cmd.exe::$DATA', 'cmd.exe:stream', 'cmd.exe\u200b', 'c\u043cd.exe', 'POWERS~1.EXE', 'WINDOW~1.EXE', '', '.exe', 'thing.scr']) {
      expect(isHighRiskProgramName(name), JSON.stringify(name)).toBe(true);
    }
    for (const notText of [undefined, null, 42]) expect(isHighRiskProgramName(notText as unknown as string)).toBe(true);
  });

  it('leaves an ordinary program ordinary, in any letter case', () => {
    for (const name of ['notepad.exe', 'NOTEPAD.EXE', 'EXCEL.EXE', 'WINWORD.EXE', 'CalculatorApp.exe', 'mspaint.exe', 'vlc.exe', 'Everything64.exe', 'FakeApp.exe']) {
      expect(isHighRiskProgramName(name), name).toBe(false);
    }
  });

  it('cannot be changed by whoever imports it', () => {
    expect(Object.isFrozen(HIGH_RISK_STEMS)).toBe(true);
    expect(Object.isFrozen(HIGH_RISK_FAMILIES)).toBe(true);
    expect(() => (HIGH_RISK_STEMS as string[]).splice(0, HIGH_RISK_STEMS.length)).toThrow();
    expect(isHighRiskProgramName('cmd.exe')).toBe(true);
    expect(HIGH_RISK_STEMS).toContain('cmd');
    expect(HIGH_RISK_FAMILIES).toContain('python');
    expect(new Set(HIGH_RISK_STEMS).size).toBe(HIGH_RISK_STEMS.length);
  });

  it('treats described call arguments as high-risk unless they are provably ordinary', () => {
    const highRisk: unknown[] = [
      {},
      null,
      undefined,
      'x',
      { app: 42 },
      { app: '' },
      { app: NOTEPAD },
      { app: NOTEPAD, appRisk: 'HIGH' },
      { app: NOTEPAD, appRisk: 'high' },
      { app: NOTEPAD, appRisk: 'unknown' },
      { app: NOTEPAD, appRisk: true },
      { app: 'notepad.exe', appRisk: 'normal', appShellView: false },
      { app: 'c:/windows/system32/notepad.exe', appRisk: 'normal', appShellView: false },
      { app: 'C:\\Windows\\System32\\cmd.exe', appRisk: 'normal', appShellView: false },
      { app: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERS~1.EXE', appRisk: 'normal', appShellView: false },
      { app: 'C:\\PROGRA~1\\App\\app.exe', appRisk: 'normal', appShellView: false },
      { app: 'C:\\Programs\\Microsoft VS Code\\C\u043ede.exe', appRisk: 'normal', appShellView: false },
      { app: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', appRisk: 'normal', appShellView: false },
      { app: 'C:\\Tools\\thing.scr', appRisk: 'normal', appShellView: false },
      { app: [NOTEPAD], appRisk: 'normal', appShellView: false },
    ];
    for (const args of highRisk) expect(isHighRiskApp(args), JSON.stringify(args)).toBe(true);
    expect(isHighRiskApp({ app: NOTEPAD, appRisk: 'normal', appShellView: false })).toBe(false);
    expect(isHighRiskApp({ app: EXCEL, appRisk: 'normal', appShellView: false, appName: 'cmd.exe' })).toBe(false);
  });
});

describe('binding an action to the window the card was about', () => {
  const described = { action: 'left_click', coordinate: [1, 2], app: NOTEPAD, appShellView: false, appWindow: 'hwnd-1', appPid: 4242, appStarted: '2026-10-12T09:00:00.000Z' };

  it('reads the full expectation from described arguments', () => {
    expect(expectationOf(described)).toEqual({ app: NOTEPAD, shellView: false, windowId: 'hwnd-1', pid: 4242, startedAt: '2026-10-12T09:00:00.000Z' });
    expect(expectationOf({ ...described, appShellView: true })).toMatchObject({ shellView: true });
    expect(Object.isFrozen(expectationOf(described))).toBe(true);
  });

  it('gives nothing unless every part is there and well-typed', () => {
    for (const field of ['app', 'appShellView', 'appWindow', 'appPid', 'appStarted']) {
      const args: Record<string, unknown> = { ...described };
      delete args[field];
      expect(expectationOf(args), field).toBeNull();
    }
    const wrong: Record<string, unknown>[] = [
      { app: 'notepad.exe' },
      { app: null },
      { appWindow: '' },
      { appWindow: 12 },
      { appWindow: 'w\u200b' },
      { appPid: '4242' },
      { appPid: 0 },
      { appPid: 2.5 },
      { appPid: Number.NaN },
      { appStarted: '' },
      { appStarted: 0 },
      { appShellView: 'false' },
      { appShellView: 0 },
      { appShellView: null },
    ];
    for (const over of wrong) expect(expectationOf({ ...described, ...over }), JSON.stringify(over)).toBeNull();
    for (const notArgs of [null, undefined, 'x', 42, [described]]) expect(expectationOf(notArgs)).toBeNull();
  });
});

describe('computer actions', () => {
  it('knows the phase-1 actions, and which of them only look', () => {
    expect(READ_ACTIONS).toEqual(['screenshot', 'cursor_position', 'wait']);
    expect(isReadAction('screenshot')).toBe(true);
    expect(isReadAction('left_click')).toBe(false);
    expect(isComputerAction('triple_click')).toBe(true);
    for (const later of ['left_click_drag', 'zoom', 'middle_click', 'hold_key', 'left_mouse_down', 'left_mouse_up', 'key_down', 'key_up', 'Screenshot', ' screenshot', 'screenshot ', 7, null, ['screenshot'], { action: 'screenshot' }]) {
      expect(isComputerAction(later), JSON.stringify(later)).toBe(false);
      expect(isReadAction(later), JSON.stringify(later)).toBe(false);
    }
  });

  it('cannot have its action lists or its limits changed by whoever imports them', () => {
    expect(Object.isFrozen(COMPUTER_ACTIONS)).toBe(true);
    expect(Object.isFrozen(READ_ACTIONS)).toBe(true);
    expect(Object.isFrozen(COMPUTER_LIMITS)).toBe(true);
    expect(() => (READ_ACTIONS as string[]).push('type')).toThrow();
    expect(() => (COMPUTER_ACTIONS as unknown as string[]).push('zoom')).toThrow();
    expect(() => {
      (COMPUTER_LIMITS as { typeTextLength: number }).typeTextLength = 1e9;
    }).toThrow();
    expect(isReadAction('type')).toBe(false);
  });

  it('states every cap in one place', () => {
    expect(COMPUTER_LIMITS).toEqual({
      keyTextLength: 64,
      keysPerCombo: 4,
      combosPerKeyAction: 1,
      typeTextLength: 4000,
      scrollAmountMin: 1,
      scrollAmountMax: 10,
      scrollAmountDefault: 3,
      waitMax: 10,
      waitDefault: 1,
      coordinateMax: 32767,
      appKeyLength: 1024,
      windowIdLength: 128,
      startedAtLength: 64,
      windowTitleLength: 80,
    });
  });

  it('reads a coordinate only as two finite, non-negative numbers inside the screenshot, as whole pixels', () => {
    expect(coordinateOf({ coordinate: [512, 300] })).toEqual([512, 300]);
    expect(coordinateOf({ coordinate: [512.6, 299.5] })).toEqual([512, 299]);
    expect(coordinateOf({ coordinate: [1365.9, 767.9] })).toEqual([1365, 767]);
    expect(coordinateOf({ coordinate: [0, 0] })).toEqual([0, 0]);
    expect(coordinateOf({ coordinate: [32767, 32767] })).toEqual([32767, 32767]);
    for (const bad of [undefined, null, [1], [1, 2, 3], ['1', 2], [-1, 5], [-0.5, 5], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY], '512,300', [1e308, 5], [2147483648, 0], [9007199254740992, 1], [32768, 0], [0, 32768]]) {
      expect(coordinateOf({ coordinate: bad }), JSON.stringify(bad)).toBeNull();
    }
    expect(coordinateOf(null)).toBeNull();
  });

  it('refuses a coordinate outside the bounds it is given', () => {
    const shot = { width: 1366, height: 768 };
    expect(coordinateOf({ coordinate: [1365.9, 767.9] }, shot)).toEqual([1365, 767]);
    expect(coordinateOf({ coordinate: [1366, 10] }, shot)).toBeNull();
    expect(coordinateOf({ coordinate: [10, 768] }, shot)).toBeNull();
    for (const bounds of [{ width: 0, height: 768 }, { width: Number.NaN, height: 768 }, { width: 1366, height: -1 }, { width: 1366 }] as { width: number; height: number }[]) {
      expect(coordinateOf({ coordinate: [1, 1] }, bounds), JSON.stringify(bounds)).toBeNull();
    }
  });
});

describe('parsing a whole action', () => {
  // A key action needs a list of the shell's shortcuts: these helpers give an empty one unless a test says otherwise.
  function parsed(args: unknown, options?: Parameters<typeof parseAction>[1]): unknown {
    const result = parseAction(args, { reserved: [], ...options });
    return result.ok ? result.action : null;
  }

  function refused(args: unknown, options?: Parameters<typeof parseAction>[1]): string {
    const result = parseAction(args, { reserved: [], ...options });
    if (result.ok) throw new Error(`Expected a refusal for ${JSON.stringify(args)}, got ${JSON.stringify(result.action)}`);
    return result.reason;
  }

  it('gives back the one form of an action that is carried out, built from validated values only', () => {
    expect(parsed({ action: 'screenshot', coordinate: 'ignored', text: 'x' })).toEqual({ action: 'screenshot' });
    expect(parsed({ action: 'cursor_position' })).toEqual({ action: 'cursor_position' });
    expect(parsed({ action: 'left_click', coordinate: [512.7, 300.2], extra: 'x', app: 'whatever' })).toEqual({ action: 'left_click', coordinate: [512, 300] });
    expect(parsed({ action: 'mouse_move', coordinate: [1, 2] })).toEqual({ action: 'mouse_move', coordinate: [1, 2] });
    expect(parsed({ action: 'scroll', coordinate: [10, 20], scroll_direction: 'down', scroll_amount: 3 })).toEqual({ action: 'scroll', coordinate: [10, 20], scroll_direction: 'down', scroll_amount: 3 });
    expect(parsed({ action: 'type', text: 'hello\n\tworld' })).toEqual({ action: 'type', text: 'hello\n\tworld' });
    // A key action is sent in the one way core writes it.
    expect(parsed({ action: 'key', text: 'S+CTRL' })).toEqual({ action: 'key', text: 'ctrl+s' });
  });

  it('refuses anything that is not exactly a known action, without echoing what it was sent', () => {
    for (const action of [undefined, null, 42, ['screenshot'], { action: 'screenshot' }, 'Screenshot', 'screenshot ', 'zoom', 'left_click_drag', 'hold_key', 'left_mouse_down', 'key_down', '']) {
      expect(parsed({ action, coordinate: [1, 2], text: 'x' }), JSON.stringify(action)).toBeNull();
    }
    for (const notArgs of [null, undefined, 'screenshot', 42, [{ action: 'screenshot' }]]) expect(parsed(notArgs)).toBeNull();
    expect(refused({ action: 'evil\u202eaction' })).toMatch(/^"evilaction" isn't a computer action Grunt can do\. Use one of: screenshot, /);
    expect(refused({ action: 'x'.repeat(5000) }).length).toBeLessThan(250);
  });

  it('holds a coordinate to the screenshot', () => {
    const shot = { bounds: { width: 1366, height: 768 } };
    expect(parsed({ action: 'left_click', coordinate: [1365.9, 767.9] }, shot)).toEqual({ action: 'left_click', coordinate: [1365, 767] });
    expect(refused({ action: 'left_click', coordinate: [1366, 10] }, shot)).toBe('That point is outside the last screenshot. Take a screenshot and use a point inside it.');
    expect(refused({ action: 'scroll', coordinate: [10, 768], scroll_direction: 'down' }, shot)).toBe('That point is outside the last screenshot. Take a screenshot and use a point inside it.');
    for (const coordinate of [undefined, [1], [1, 2, 3], ['1', 2], [-1, 5], [Number.NaN, 1], '512,300', [1e308, 5], [2147483648, 0], [32768, 1]]) {
      for (const action of ['mouse_move', 'left_click', 'right_click', 'double_click', 'triple_click', 'scroll']) {
        expect(refused({ action, coordinate, scroll_direction: 'down' }, shot), `${action} ${JSON.stringify(coordinate)}`).toBe(
          `A ${action} action needs "coordinate": [x, y], two numbers in the last screenshot's pixels.`
        );
      }
    }
  });

  it('holds a scroll to one of four directions and a whole amount from 1 to 10', () => {
    const scroll = (over: Record<string, unknown>): Record<string, unknown> => ({ action: 'scroll', coordinate: [10, 20], scroll_direction: 'down', ...over });
    expect(parsed(scroll({}))).toEqual({ action: 'scroll', coordinate: [10, 20], scroll_direction: 'down', scroll_amount: 3 });
    for (const scroll_amount of [1, 2, 10]) expect(parsed(scroll({ scroll_amount }))).toMatchObject({ scroll_amount });
    for (const scroll_direction of ['up', 'down', 'left', 'right']) expect(parsed(scroll({ scroll_direction }))).toMatchObject({ scroll_direction });
    for (const scroll_amount of [0, 11, -1, 2.5, 1e9, Number.NaN, Number.POSITIVE_INFINITY, '3', [3], {}]) {
      expect(refused(scroll({ scroll_amount })), JSON.stringify(scroll_amount)).toBe('"scroll_amount" is a whole number from 1 to 10.');
    }
    for (const scroll_direction of [undefined, 'sideways', 'Down', 'DOWN', 'down ', 'x'.repeat(300), 42, ['down'], { toString: () => 'down' }]) {
      expect(refused(scroll({ scroll_direction })), JSON.stringify(scroll_direction)).toBe('A scroll action needs "scroll_direction": up, down, left or right.');
    }
  });

  it('holds typed text to 4000 characters, counted as characters', () => {
    expect(parsed({ action: 'type', text: 'a'.repeat(4000) })).toEqual({ action: 'type', text: 'a'.repeat(4000) });
    // An emoji is one character though it is two UTF-16 units.
    expect(parsed({ action: 'type', text: '\u{1f600}'.repeat(4000) })).toMatchObject({ action: 'type' });
    const tooMuch = 'That is too much to type in one action (at most 4000 characters). Send it in parts.';
    expect(refused({ action: 'type', text: 'a'.repeat(4001) })).toBe(tooMuch);
    expect(refused({ action: 'type', text: '\u{1f600}'.repeat(4001) })).toBe(tooMuch);
    expect(refused({ action: 'type', text: 'a'.repeat(5_000_000) })).toBe(tooMuch);
    for (const text of [undefined, null, '', 42, ['a'], { text: 'a' }]) {
      expect(refused({ action: 'type', text }), JSON.stringify(text)).toBe('A type action needs "text": the text to type.');
    }
  });

  it('types line breaks and tabs, and no other control character', () => {
    expect(parsed({ action: 'type', text: 'one\ntwo\tthree' })).toEqual({ action: 'type', text: 'one\ntwo\tthree' });
    // Text that is not a control character is typed as it is, hidden or not: the card spells it out.
    expect(parsed({ action: 'type', text: 'caf\u00e9 \u202e\u200b\u2028 \ufffd \u{1f600}' })).toMatchObject({ action: 'type' });
    const controls = [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0d, 0x1a, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f];
    for (const code of controls) {
      const reason = refused({ action: 'type', text: `ab${String.fromCharCode(code)}cd` });
      expect(reason, code.toString(16)).toMatch(/control character/);
      expect(reason.includes(String.fromCharCode(code)), code.toString(16)).toBe(false);
    }
    expect(refused({ action: 'type', text: 'line one\r\nline two' })).toMatch(/control character/);
    for (const text of ['broken \ud83d', '\ude00 broken', 'bro\ud800ken']) {
      expect(refused({ action: 'type', text }), JSON.stringify(text)).toMatch(/isn't a character/);
    }
  });

  it('holds a key action to one canonical combination that stays in the app', () => {
    expect(parsed({ action: 'key', text: 'Shift+CONTROL+s' })).toEqual({ action: 'key', text: 'ctrl+shift+s' });
    for (const text of ['ctrl+Escape', 'alt+Tab', 'alt+F4', 'super+r', 'OS+r', 'ctrl+alt+Delete', 'Print', 'shift', 'ctrl+a ctrl+c', 'ctrl+Escape c m d Return', 'XF86Search', 's'.repeat(65), 'a+b+c+d+e', '', undefined, 42]) {
      expect(parsed({ action: 'key', text }), JSON.stringify(text)).toBeNull();
    }
    expect(refused({ action: 'key', text: 'super+r' })).toBe('Key combinations with the Windows key are never sent.');
    expect(parsed({ action: 'key', text: 'ctrl+shift+space' })).toEqual({ action: 'key', text: 'ctrl+shift+space' });
    expect(refused({ action: 'key', text: 'ctrl+shift+space' }, { reserved: ['Ctrl+Shift+Space'] })).toMatch(/Grunt's own shortcuts/);
    // The shell has not said what its shortcuts are: no key goes out, a bare one included.
    expect(refused({ action: 'key', text: 'ctrl+s' }, { reserved: null })).toBe(SHORTCUTS_UNKNOWN_REASON);
    expect(refused({ action: 'key', text: 'Return' }, { reserved: null })).toBe(SHORTCUTS_UNKNOWN_REASON);
    expect(refused({ action: 'key', text: 'F9' }, { reserved: null })).toBe(SHORTCUTS_UNKNOWN_REASON);
    // Everything else is untouched by it.
    expect(parsed({ action: 'type', text: 'x' }, { reserved: null })).toEqual({ action: 'type', text: 'x' });
    expect(parsed({ action: 'left_click', coordinate: [1, 2] }, { reserved: null })).toEqual({ action: 'left_click', coordinate: [1, 2] });
    expect(parsed({ action: 'screenshot' }, { reserved: null })).toEqual({ action: 'screenshot' });
  });

  it('treats a list that is not an array as no list, whatever shape it has, and a missing one too', () => {
    const odd: unknown[] = [undefined, '', 'Ctrl+Shift+Space', {}, { length: 0 }, 0, 1, false, true, NaN, Symbol('x'), () => [], new Set<string>(), new Map<string, string>()];
    for (const reserved of odd) {
      for (const text of ['F9', 'Return', 'ctrl+s']) {
        const result = parseAction({ action: 'key', text }, { reserved });
        expect(result.ok, `${String(reserved)} ${text}`).toBe(false);
        expect(!result.ok && result.reason, `${String(reserved)} ${text}`).toBe(SHORTCUTS_UNKNOWN_REASON);
      }
    }
    // A caller that leaves the key out altogether, or hands over no options at all, gets the same answer for a key action.
    expect(parseAction({ action: 'key', text: 'F9' }, {})).toEqual({ ok: false, reason: SHORTCUTS_UNKNOWN_REASON });
    expect(parseAction({ action: 'key', text: 'F9' })).toEqual({ ok: false, reason: SHORTCUTS_UNKNOWN_REASON });
    expect(parseAction({ action: 'key', text: 'F9' }, null as never)).toEqual({ ok: false, reason: SHORTCUTS_UNKNOWN_REASON });
    expect(parseAction({ action: 'key', text: 'F9' }, 'x' as never)).toEqual({ ok: false, reason: SHORTCUTS_UNKNOWN_REASON });
    // Looks and typed text never needed a list.
    for (const reserved of odd) {
      expect(parseAction({ action: 'type', text: 'x' }, { reserved }).ok).toBe(true);
      expect(parseAction({ action: 'wait' }, { reserved }).ok).toBe(true);
    }
    // Only an explicit array lists shortcuts, and an empty one means none to hold back.
    expect(parsed({ action: 'key', text: 'F9' }, { reserved: [] })).toEqual({ action: 'key', text: 'f9' });
    expect(refused({ action: 'key', text: 'F9' }, { reserved: ['F9'] })).toMatch(/Grunt's own shortcuts/);
    // The summary and the broker, which only run after the tool checked the real list, still read a key action.
    expect(actionSummary({ action: 'key', text: 'F9' })).toBe('press f9');
    expect(actionSummary({ action: 'key', text: 'ctrl+s' })).toBe('press ctrl+s');
  });

  it('freezes the point of an action it parses, and the point of the described arguments', () => {
    const result = parseAction({ action: 'left_click', coordinate: [10, 20] });
    if (!result.ok || !('coordinate' in result.action)) throw new Error('expected a click');
    expect(Object.isFrozen(result.action.coordinate)).toBe(true);
    expect(() => {
      (result.action as { coordinate: number[] }).coordinate[0] = 999;
    }).toThrow(TypeError);
    const scroll = parseAction({ action: 'scroll', coordinate: [3, 4], scroll_direction: 'up' });
    if (!scroll.ok || !('coordinate' in scroll.action)) throw new Error('expected a scroll');
    expect(Object.isFrozen(scroll.action.coordinate)).toBe(true);
    // It is a fresh array each time, never the model's own.
    const given = [5, 6];
    const again = parseAction({ action: 'mouse_move', coordinate: given });
    if (!again.ok || !('coordinate' in again.action)) throw new Error('expected a move');
    expect(again.action.coordinate).not.toBe(given);
    expect(Object.isFrozen(given)).toBe(false);
  });

  it('cuts a wait to ten seconds, and refuses one that is not a length of time', () => {
    // Left out (or null, as some callers write a missing value), it is one second.
    expect(parsed({ action: 'wait' })).toEqual({ action: 'wait', duration: 1 });
    expect(parsed({ action: 'wait', duration: null })).toEqual({ action: 'wait', duration: 1 });
    expect(parsed({ action: 'wait', duration: 2 })).toEqual({ action: 'wait', duration: 2 });
    expect(parsed({ action: 'wait', duration: 0 })).toEqual({ action: 'wait', duration: 0 });
    expect(parsed({ action: 'wait', duration: 2.54 })).toEqual({ action: 'wait', duration: 2.5 });
    expect(parsed({ action: 'wait', duration: 10 })).toEqual({ action: 'wait', duration: 10 });
    expect(parsed({ action: 'wait', duration: 10.01 })).toEqual({ action: 'wait', duration: 10 });
    expect(parsed({ action: 'wait', duration: 1e9 })).toEqual({ action: 'wait', duration: 10 });
    expect(parsed({ action: 'wait', duration: Number.MAX_VALUE })).toEqual({ action: 'wait', duration: 10 });
    for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.001, '5', [5], {}]) {
      expect(refused({ action: 'wait', duration }), JSON.stringify(duration)).toBe('A wait needs "duration": a number of seconds from 0 to 10.');
    }
  });

  it('never gives back more than it was given the right to: every parsed action is inside every cap', () => {
    const inputs: unknown[] = [
      { action: 'wait', duration: 1e308 },
      { action: 'scroll', coordinate: [32767.9, 32767.9], scroll_direction: 'up', scroll_amount: 10 },
      { action: 'type', text: 'x'.repeat(4000) },
      { action: 'key', text: 'ctrl+shift+F12' },
      { action: 'left_click', coordinate: [32767.99, 0] },
    ];
    for (const input of inputs) {
      const result = parseAction(input, { reserved: [] });
      if (!result.ok) throw new Error(`Expected ${JSON.stringify(input)} to parse`);
      const action = result.action;
      if (action.action === 'wait') expect(action.duration).toBeLessThanOrEqual(COMPUTER_LIMITS.waitMax);
      if ('coordinate' in action) for (const n of action.coordinate) expect(n).toBeLessThanOrEqual(COMPUTER_LIMITS.coordinateMax);
      if (action.action === 'scroll') expect(action.scroll_amount).toBeLessThanOrEqual(COMPUTER_LIMITS.scrollAmountMax);
      if (action.action === 'type') expect(Array.from(action.text).length).toBeLessThanOrEqual(COMPUTER_LIMITS.typeTextLength);
      if (action.action === 'key') {
        expect(action.text.length).toBeLessThanOrEqual(COMPUTER_LIMITS.keyTextLength);
        expect(action.text.split('+').length).toBeLessThanOrEqual(COMPUTER_LIMITS.keysPerCombo);
      }
      // What comes back parses to itself: it is the canonical form.
      expect(parseAction(action, { reserved: [] })).toEqual({ ok: true, action });
    }
  });
});

describe('the line that says what an action does', () => {
  it('summarises an action in one short line', () => {
    expect(actionSummary({ action: 'left_click', coordinate: [512, 300] })).toBe('click at 512, 300');
    expect(actionSummary({ action: 'right_click', coordinate: [5, 6] })).toBe('right-click at 5, 6');
    expect(actionSummary({ action: 'double_click', coordinate: [1, 2] })).toBe('double-click at 1, 2');
    expect(actionSummary({ action: 'triple_click', coordinate: [1, 2] })).toBe('triple-click at 1, 2');
    expect(actionSummary({ action: 'mouse_move', coordinate: [1, 2] })).toBe('move the mouse to 1, 2');
    expect(actionSummary({ action: 'scroll', coordinate: [10, 20], scroll_direction: 'down', scroll_amount: 3 })).toBe('scroll down 3 at 10, 20');
    expect(actionSummary({ action: 'screenshot' })).toBe('take a screenshot');
    expect(actionSummary({ action: 'cursor_position' })).toBe('read the cursor position');
    expect(actionSummary({ action: 'wait', duration: 2 })).toBe('wait 2 s');
    expect(actionSummary({ action: 'wait' })).toBe('wait 1 s');
  });

  it('never holds the text a type action will type, only how much of it there is', () => {
    const payload = `${'a'.repeat(40)}; rm -rf /`;
    expect(actionSummary({ action: 'type', text: payload })).toBe('type 50 characters');
    expect(actionSummary({ action: 'type', text: 'x' })).toBe('type 1 character');
    expect(actionSummary({ action: 'type', text: 'line one\nline two\nline three' })).toBe('type 28 characters (3 lines)');
    expect(actionSummary({ action: 'type', text: 'hi\u202e\u200b"\nsecond' })).toBe('type 12 characters (2 lines)');
    // An emoji is one character, and the line is never cut through one.
    expect(actionSummary({ action: 'type', text: `${'a'.repeat(39)}\u{1f600}\u{1f600}` })).toBe('type 41 characters');
    for (const text of [payload, 'hunter2', 'hi\u202e\u200b"\nsecond']) {
      const summary = actionSummary({ action: 'type', text });
      expect(summary).not.toContain('rm -rf');
      expect(summary).not.toContain('hunter2');
      expect(summary).toMatch(/^type \d+ characters?( \(\d+ lines\))?$/);
    }
    // Text that would not be typed at all has no count either.
    expect(actionSummary({ action: 'type', text: 'hi\u0000\u001b[31m' })).toBe('type ?');
    expect(actionSummary({ action: 'type', text: 'a'.repeat(4001) })).toBe('type ?');
  });

  it('shows the full typed text, with hidden characters spelled out, only where the card asks for it', () => {
    const payload = `${'a'.repeat(40)}; rm -rf /`;
    expect(typedTextForCard({ action: 'type', text: payload })).toBe(payload);
    expect(typedTextForCard({ action: 'type', text: 'one\ntwo\tx\u202e\u0000' })).toBe('one\ntwo\tx<U+202E><U+0000>');
    expect(typedTextForCard({ action: 'type', text: 'bad \ud83d' })).toBe('bad <U+D83D>');
    expect(typedTextForCard({ action: 'key', text: 'ctrl+s' })).toBeNull();
    expect(typedTextForCard({ action: 'type', text: 42 })).toBeNull();
    expect(typedTextForCard(null)).toBeNull();
  });

  it('shows a key action as the canonical combination, and nothing it could not read', () => {
    expect(actionSummary({ action: 'key', text: 'ctrl+s' })).toBe('press ctrl+s');
    expect(actionSummary({ action: 'key', text: 'S+Shift+CONTROL' })).toBe('press ctrl+shift+s');
    expect(actionSummary({ action: 'key', text: 'Return' })).toBe('press return');
    expect(actionSummary({ action: 'key', text: 'Return\nAllowed by policy.\n\u202egnp.exe' })).toBe('press ?');
    expect(actionSummary({ action: 'key', text: 'x'.repeat(300) })).toBe('press ?');
    expect(actionSummary({ action: 'key', text: 'ctrl+Escape' })).toBe('press ?');
    expect(actionSummary({ action: 'key', text: 'alt+F4' })).toBe('press ?');
    expect(actionSummary({ action: 'key' })).toBe('press ?');
  });

  it('never echoes a value it did not validate', () => {
    expect(actionSummary({ action: 'scroll', coordinate: [1, 2], scroll_direction: 'x'.repeat(300), scroll_amount: 3 })).toBe('scroll ?');
    expect(actionSummary({ action: 'scroll', coordinate: [1, 2], scroll_direction: { a: 'b' }, scroll_amount: { c: 'd' } })).toBe('scroll ?');
    expect(actionSummary({ action: 'scroll', coordinate: [1, 2], scroll_direction: 'down', scroll_amount: 1e9 })).toBe('scroll ?');
    expect(actionSummary({ action: 'left_click', coordinate: 'here' })).toBe('click ?');
    expect(actionSummary({ action: 'mouse_move', coordinate: [1e308, 5] })).toBe('move the mouse ?');
    expect(actionSummary({ action: 'type', text: 42 })).toBe('type ?');
    expect(actionSummary({ action: 'Approved by Grunt policy\u202e' })).toBe('?');
    expect(actionSummary({ action: 'left_click_drag' })).toBe('?');
    expect(actionSummary({ action: 42 })).toBe('?');
    expect(actionSummary(null)).toBe('?');
    // A wait longer than the cap says the cap; one that is not a number says nothing.
    expect(actionSummary({ action: 'wait', duration: 1e9 })).toBe('wait 10 s');
    expect(actionSummary({ action: 'wait', duration: Number.NaN })).toBe('wait ?');
    expect(actionSummary({ action: 'wait', duration: 'forever' })).toBe('wait ?');
    for (const args of [{ action: 'type', text: `${'a'.repeat(39)}\u{1f600}` }, { action: 'key', text: '\ud83d' }, { action: '\ud83d' }]) {
      expect(isWellFormedText(actionSummary(args))).toBe(true);
    }
  });
});

describe('round 2: file dialogs, shares, look-alike folders and the longer list', () => {
  it('asks every time for a file dialog or a shell file view inside an ordinary app', () => {
    // Notepad's own Open dialog: the same program, signed, on a fixed disk.
    const dialog = app(classifyTarget(target({ shellView: true, title: 'Open', windowId: 'hwnd-dialog' })));
    expect(dialog).toMatchObject({ key: NOTEPAD, name: 'notepad.exe', risk: 'high', windowId: 'hwnd-dialog' });
    expect(isHighRiskApp({ action: 'left_click', coordinate: [1, 2], ...appArgs(dialog) })).toBe(true);
    // The main window of the same program stays ordinary.
    const main = app(classifyTarget(target({ shellView: false })));
    expect(main.risk).toBe('normal');
    expect(isHighRiskApp({ action: 'left_click', coordinate: [1, 2], ...appArgs(main) })).toBe(false);
  });

  it('never calls a target ordinary when it was not told whether it is a file dialog', () => {
    for (const t of [without('shellView'), target({ shellView: undefined }), target({ shellView: null }), target({ shellView: 'false' }), target({ shellView: 0 })]) {
      expect(app(classifyTarget(t)).risk, JSON.stringify(t['shellView'])).toBe('high');
    }
  });

  it('asks every time for a program on a share, whatever kind of drive the shell said it is on', () => {
    const share = '\\\\server\\share\\App.exe';
    expect(appKey(share)).toBe(share);
    for (const location of ['fixed', 'network', 'unknown']) {
      expect(app(classifyTarget(target({ path: share, originalName: null, location }))).risk, location).toBe('high');
    }
    expect(isHighRiskApp({ app: share, appRisk: 'normal', appShellView: false })).toBe(true);
    expect(isHighRiskApp({ app: '\\\\localhost\\c$\\Windows\\System32\\notepad.exe', appRisk: 'normal', appShellView: false })).toBe(true);
  });

  it('flags a space that is not a plain space anywhere in the path, not only in the file name', () => {
    // A folder named "Slack" plus a no-break space, an en space, an ideographic space, a narrow no-break space.
    for (const space of ['\u00a0', '\u2002', '\u3000', '\u202f', '\u1680', '\u205f', '\u2000', '\u200a']) {
      const key = `C:\\Users\\a\\AppData\\Local\\Slack${space}\\slack.exe`;
      expect(appKey(key), space.codePointAt(0)?.toString(16)).toBe(key);
      expect(describeApp(key)?.unusual, space.codePointAt(0)?.toString(16)).toBe(true);
      expect(app(classifyTarget(target({ path: key, originalName: null }))).risk, space.codePointAt(0)?.toString(16)).toBe('high');
      expect(isHighRiskApp({ app: key, appRisk: 'normal', appShellView: false }), space.codePointAt(0)?.toString(16)).toBe(true);
      // In the middle of a folder name and at the start of one, too.
      expect(describeApp(`C:\\Program${space}Files\\App\\app.exe`)?.unusual).toBe(true);
      expect(describeApp(`C:\\${space}App\\app.exe`)?.unusual).toBe(true);
    }
    // A plain space in a folder is ordinary.
    expect(describeApp('C:\\Program Files\\Fake App\\FakeApp.exe')?.unusual).toBe(false);
    expect(app(classifyTarget(target({ path: 'C:\\Program Files\\Fake App\\FakeApp.exe', originalName: null }))).risk).toBe('normal');
  });

  it('holds the remote-help tools, file managers, scriptable editors and automation hosts', () => {
    const names = [
      'quickassist.exe', 'msra.exe', 'WindowsSandbox.exe', 'WindowsSandboxClient.exe', 'mRemoteNG.exe', 'RDCMan.exe', 'TOTALCMD.EXE', 'TOTALCMD64.EXE',
      'doublecmd.exe', 'dopus.exe', 'notepad++.exe', 'sublime_text.exe', 'Zed.exe', 'AutoHotkey.exe', 'AutoHotkey64.exe', 'AutoHotkeyU64.exe', 'OpenWith.exe',
      'gateway64.exe', 'gateway.exe', 'mps64.exe', 'mps.exe',
    ];
    for (const name of names) expect(isHighRiskProgramName(name), name).toBe(true);
    for (const family of ['windowssandbox', 'totalcmd', 'autohotkey']) expect(HIGH_RISK_FAMILIES).toContain(family);
    expect(new Set(HIGH_RISK_STEMS).size).toBe(HIGH_RISK_STEMS.length);
  });

  it('asks every time for anything JetBrains signed, so a product that is on no list yet is covered', () => {
    const fresh = { path: 'C:\\Program Files\\JetBrains\\NewThing 2027.1\\bin\\newthing64.exe', originalName: 'newthing64.exe' };
    expect(isHighRiskProgramName('newthing64.exe')).toBe(false);
    for (const signer of ['JetBrains s.r.o.', 'CN=JetBrains s.r.o., O=JetBrains s.r.o., L=Praha, C=CZ', 'JETBRAINS S.R.O.', 'jetbrains']) {
      expect(app(classifyTarget(target({ ...fresh, signer }))).risk, signer).toBe('high');
    }
    expect(app(classifyTarget(target({ ...fresh, signer: 'Some Other Software Ltd' }))).risk).toBe('normal');
  });
});

describe('round 2: identity is the path as it stands, and anything outside plain ASCII in it asks every time', () => {
  // Each of these is a valid key (the shell resolved it), is a different key from its plain look-alike,
  // and is asked about every time with a warning on the card.
  const unusual: [string, string][] = [
    ['an accented letter in a user folder', 'C:\\Users\\Jos\u00e9\\AppData\\Local\\App\\app.exe'],
    ['another script in a user folder', 'C:\\Users\\\u5c71\u7530\\App\\app.exe'],
    ['a Cyrillic letter that reads as a Latin one, in a folder', 'C:\\Program Files\\Sl\u0430ck\\slack.exe'],
    ['the same in the file name', 'C:\\Program Files\\Slack\\sl\u0430ck.exe'],
    ['a Greek letter that reads as a Latin one', 'C:\\Program Files\\\u0391pp\\app.exe'],
    ['full-width letters', 'C:\\Program Files\\\uff33\uff4c\uff41\uff43\uff4b\\slack.exe'],
    ['a combining mark', 'C:\\Program Files\\Cafe\u0301\\app.exe'],
    ['the Kelvin sign', 'C:\\Program Files\\Slac\u212a\\slack.exe'],
    ['a no-break space at the end of a folder name', 'C:\\Program Files\\Slack\u00a0\\slack.exe'],
    ['an ideographic space', 'C:\\Program Files\\Slack\u3000App\\slack.exe'],
    ['an emoji', 'C:\\Tools\\\u{1f600}\\app.exe'],
  ];

  it('keeps the key byte for byte, flags it, and classifies the app once-only', () => {
    for (const [what, key] of unusual) {
      expect(appKey(key), what).toBe(key);
      const described = describeApp(key);
      expect(described?.key, what).toBe(key);
      expect(described?.unusual, what).toBe(true);
      expect(app(classifyTarget(target({ path: key, originalName: null }))).risk, what).toBe('high');
      expect(isHighRiskApp({ app: key, appRisk: 'normal', appShellView: false }), what).toBe(true);
    }
  });

  it('shows letters as they are and spells out a space that is not the plain one', () => {
    const nbsp = describeApp('C:\\Program Files\\Slack\u00a0\\slack.exe');
    expect(nbsp?.path).toBe('C:\\Program Files\\Slack<U+00A0>\\slack.exe');
    expect(nbsp?.name).toBe('slack.exe');
    const trailing = describeApp('C:\\a\\app.exe\u00a0');
    expect(trailing?.name).toBe('app.exe<U+00A0>');
    expect(trailing?.path).toBe('C:\\a\\app.exe<U+00A0>');
    expect(trailing?.key).toBe('C:\\a\\app.exe\u00a0');
    expect(describeApp('C:\\Program Files\\Slack\u3000App\\slack.exe')?.path).toBe('C:\\Program Files\\Slack<U+3000>App\\slack.exe');
    // A letter from another script is shown as it is: the flag is what warns.
    expect(describeApp('C:\\Users\\Jos\u00e9\\AppData\\Local\\App\\app.exe')?.path).toBe('C:\\Users\\Jos\u00e9\\AppData\\Local\\App\\app.exe');
    expect(describeApp('C:\\Program Files\\Slack\\sl\u0430ck.exe')?.name).toBe('sl\u0430ck.exe');
    // Nothing is spelled out in a plain path.
    expect(describeApp(EXCEL)?.path).toBe(EXCEL);
  });

  it('has no key at all for a path with a hidden, bidi or zero-width character, wherever it is', () => {
    for (const hidden of ['\u202e', '\u2066', '\u200b', '\u200d', '\ufeff', '\u00ad', '\ufe0f', '\u0000', '\u001b', '\u007f', '\u0085', '\u2028']) {
      for (const key of [`C:\\Program Files\\Slack${hidden}\\slack.exe`, `C:\\Program Files\\Slack\\slack${hidden}.exe`, `C:\\${hidden}Program Files\\Slack\\slack.exe`]) {
        expect(appKey(key), hidden.codePointAt(0)?.toString(16)).toBeNull();
        expect(describeApp(key)).toBeNull();
      }
    }
  });

  it('confirms each rule of the validator and each high-risk rule of the path with one vector', () => {
    const noKey: [string, string][] = [
      ['a trailing dot', 'C:\\a\\b.exe.'],
      ['a trailing space', 'C:\\a\\b.exe '],
      ['a folder ending in a dot', 'C:\\a.\\b.exe'],
      ['a folder ending in a space', 'C:\\a \\b.exe'],
      ['an NTFS stream', 'C:\\a\\b.exe:stream'],
      ['the default stream', 'C:\\a\\b.exe::$DATA'],
      ['a verbatim prefix', '\\\\?\\C:\\a\\b.exe'],
      ['a device prefix', '\\\\.\\C:\\a\\b.exe'],
      ['an NT object prefix', '\\??\\C:\\a\\b.exe'],
      ['a verbatim UNC prefix', '\\\\?\\UNC\\s\\sh\\b.exe'],
      ['a device path', '\\Device\\HarddiskVolume3\\a\\b.exe'],
      ['a forward slash', 'C:/a/b.exe'],
      ['mixed separators', 'C:\\a/b.exe'],
      ['an empty segment', 'C:\\a\\\\b.exe'],
      ['a dot segment', 'C:\\a\\.\\b.exe'],
      ['a dot-dot segment', 'C:\\a\\..\\b.exe'],
      ['a trailing separator', 'C:\\a\\b.exe\\'],
      ['a drive-relative path', 'C:b.exe'],
      ['a bare name', 'b.exe'],
    ];
    for (const [what, raw] of noKey) expect(appKey(raw), what).toBeNull();
    const onceOnly: [string, string][] = [
      ['an 8.3 file name', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\POWERS~1.EXE'],
      ['an 8.3 folder', 'C:\\PROGRA~1\\App\\app.exe'],
      ['a share', '\\\\server\\share\\App.exe'],
      ['an administrative share of this machine', '\\\\localhost\\c$\\Windows\\System32\\notepad.exe'],
    ];
    for (const [what, key] of onceOnly) {
      expect(appKey(key), what).toBe(key);
      expect(isHighRiskApp({ app: key, appRisk: 'normal', appShellView: false }), what).toBe(true);
    }
  });
});

describe('round 2: one described target for the card, the grant, the risk and the action', () => {
  const DIALOG = { shellView: true, title: 'Open', windowId: 'hwnd-dialog' };

  it('describes a target once, in an object nothing can change afterwards', () => {
    const described = app(classifyTarget(target()));
    expect(Object.isFrozen(described)).toBe(true);
    expect(() => {
      (described as { risk: string }).risk = 'normal';
    }).toThrow();
    expect(() => {
      (described as { shellView: boolean }).shellView = false;
    }).toThrow();
    expect(Object.isFrozen(classifyTarget({}))).toBe(true);
    // The target handed in is not what is kept: changing it afterwards changes nothing.
    const live = target();
    const kept = app(classifyTarget(live));
    live['path'] = 'C:\\Windows\\System32\\cmd.exe';
    live['shellView'] = true;
    expect(kept).toMatchObject({ key: NOTEPAD, shellView: false, risk: 'normal' });
  });

  it('carries whether the window is a file view, and counts not knowing as being one', () => {
    expect(app(classifyTarget(target())).shellView).toBe(false);
    expect(app(classifyTarget(target(DIALOG))).shellView).toBe(true);
    for (const shellView of [undefined, null, 'false', 0, 'no']) {
      expect(app(classifyTarget(target({ shellView }))), JSON.stringify(shellView)).toMatchObject({ shellView: true, risk: 'high' });
    }
    expect(app(classifyTarget(without('shellView')))).toMatchObject({ shellView: true, risk: 'high' });
  });

  it('puts exactly the described target and the parsed action into the described arguments', () => {
    expect(APP_ARG_FIELDS).toEqual(['app', 'appName', 'appTitle', 'appRisk', 'appShellView', 'appWindow', 'appPid', 'appStarted']);
    const dialog = app(classifyTarget(target(DIALOG)));
    // What a model might send to pass a file dialog off as the app's ordinary window.
    const forged = {
      action: 'left_click',
      coordinate: [10.9, 20.2],
      app: NOTEPAD,
      appName: 'notepad.exe',
      appTitle: 'Untitled - Notepad',
      appRisk: 'normal',
      appShellView: false,
      appWindow: 'hwnd-1',
      appPid: 4242,
      appStarted: '2026-10-12T09:00:00.000Z',
      somethingElse: 'x',
    };
    const parsed = parseAction(forged);
    if (!parsed.ok || parsed.action.action !== 'left_click') throw new Error('expected a click');
    expect(parsed.action).toEqual({ action: 'left_click', coordinate: [10, 20] });
    const args = describedCallArgs(parsed.action, dialog);
    expect(args).toEqual({
      action: 'left_click',
      coordinate: [10, 20],
      app: NOTEPAD,
      appName: 'notepad.exe',
      appTitle: 'Open',
      appRisk: 'high',
      appShellView: true,
      appWindow: 'hwnd-dialog',
      appPid: 4242,
      appStarted: '2026-10-12T09:00:00.000Z',
    });
    expect(Object.isFrozen(args)).toBe(true);
    // Frozen all the way down: code in this process can't move the point once the person has approved it.
    const point = args['coordinate'] as number[];
    expect(Object.isFrozen(point)).toBe(true);
    expect(() => {
      point[0] = 999;
    }).toThrow(TypeError);
    expect(() => point.push(5)).toThrow(TypeError);
    expect(actionSummary(args)).toBe('click at 10, 20');
    // It is a copy: the parsed action's own point is not the described one.
    expect(point).not.toBe(parsed.action.coordinate);
    // Every reader takes its answer from those same fields.
    expect(isHighRiskApp(args)).toBe(true);
    expect(expectationOf(args)).toEqual({ app: NOTEPAD, shellView: true, windowId: 'hwnd-dialog', pid: 4242, startedAt: '2026-10-12T09:00:00.000Z' });
    expect(describeApp(args['app'])?.name).toBe('notepad.exe');
    expect(actionSummary(args)).toBe('click at 10, 20');
  });

  it('reads the risk from the described fields: a file view is never ordinary, whatever risk the call claims', () => {
    const ordinary = { app: NOTEPAD, appRisk: 'normal', appShellView: false };
    expect(isHighRiskApp(ordinary)).toBe(false);
    for (const appShellView of [true, undefined, null, 'false', 0]) expect(isHighRiskApp({ ...ordinary, appShellView }), JSON.stringify(appShellView)).toBe(true);
    expect(isHighRiskApp({ app: NOTEPAD, appRisk: 'normal' })).toBe(true);
  });
});

describe('round 2: nothing can hold a key or a button down', () => {
  it('has no action that presses without releasing, by any name', () => {
    for (const name of COMPUTER_ACTIONS) expect(name, name).not.toMatch(/hold|down|_up$|press|release|drag/);
    const held = [
      'hold_key', 'key_down', 'key_up', 'keydown', 'keyup', 'press', 'release', 'press_key', 'release_key', 'left_mouse_down', 'left_mouse_up',
      'mouse_down', 'mouse_up', 'right_mouse_down', 'left_click_drag', 'drag', 'hold',
    ];
    for (const action of held) {
      const result = parseAction({ action, text: 'shift', coordinate: [1, 2], duration: 5 });
      expect(result.ok, action).toBe(false);
      expect(actionSummary({ action, text: 'shift' }), action).toBe('?');
    }
  });

  it('gives every action that changes something as a whole thing: no field asks to hold, and none lasts', () => {
    const whole: Record<string, string[]> = {
      left_click: ['action', 'coordinate'],
      right_click: ['action', 'coordinate'],
      double_click: ['action', 'coordinate'],
      triple_click: ['action', 'coordinate'],
      mouse_move: ['action', 'coordinate'],
      scroll: ['action', 'coordinate', 'scroll_amount', 'scroll_direction'],
      type: ['action', 'text'],
      key: ['action', 'text'],
    };
    for (const [action, fields] of Object.entries(whole)) {
      const result = parseAction({ action, coordinate: [1, 2], scroll_direction: 'down', text: action === 'key' ? 'ctrl+s' : 'x', duration: 5, hold: true, down: true, release: false }, { reserved: [] });
      if (!result.ok) throw new Error(`Expected ${action} to parse`);
      expect(Object.keys(result.action).sort(), action).toEqual(fields);
    }
  });
});

describe('a run nobody is watching', () => {
  it('is anything but a plain false, or nothing at all: the one test the broker and the tool both use', () => {
    for (const value of [true, 'true', 'false', 1, 0, null, {}, [], '']) expect(isUnattendedRun({ unattended: value }), JSON.stringify(value)).toBe(true);
    expect(isUnattendedRun({})).toBe(false);
    expect(isUnattendedRun({ unattended: undefined })).toBe(false);
    expect(isUnattendedRun({ unattended: false })).toBe(false);
  });
});
