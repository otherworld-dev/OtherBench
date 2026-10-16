import { describe, expect, it } from 'vitest';
import { isKeyCombination, isSensitiveKeyText, KEY_LIMITS, KEY_MODIFIERS, KEY_NAMES, parseKeys, SHORTCUTS_UNKNOWN_REASON } from '../src/domain/computer-keys.js';

function canonical(text: unknown, reserved: unknown = []): string | null {
  const parsed = parseKeys(text, reserved);
  return parsed.ok ? parsed.text : null;
}

function reason(text: unknown, reserved: unknown = []): string {
  const parsed = parseKeys(text, reserved);
  if (parsed.ok) throw new Error(`Expected a refusal for ${JSON.stringify(text)}, got ${parsed.text}`);
  return parsed.reason;
}

describe('computer keys', () => {
  it('reads one combination and writes it one way: lower case, modifiers first in a fixed order', () => {
    expect(parseKeys('ctrl+s', [])).toEqual({ ok: true, combos: [['ctrl', 's']], text: 'ctrl+s' });
    expect(parseKeys('ctrl+shift+s', [])).toEqual({ ok: true, combos: [['ctrl', 'shift', 's']], text: 'ctrl+shift+s' });
    const same: Record<string, string> = {
      Return: 'return',
      Enter: 'return',
      F5: 'f5',
      'shift+Tab': 'shift+tab',
      'ctrl+F4': 'ctrl+f4',
      'shift+F10': 'shift+f10',
      'ctrl+shift+F12': 'ctrl+shift+f12',
      F1: 'f1',
      Page_Down: 'page_down',
      Next: 'page_down',
      'CTRL+S': 'ctrl+s',
      's+ctrl': 'ctrl+s',
      'shift+ctrl+S': 'ctrl+shift+s',
      'Control_R+Shift_L+s': 'ctrl+shift+s',
      'ctrl+ctrl+s': 'ctrl+s',
      Esc: 'escape',
      'shift+Escape': 'shift+escape',
      BackSpace: 'backspace',
      Delete: 'delete',
      'ctrl+plus': 'ctrl+equal',
      'ctrl+7': 'ctrl+7',
      F12: 'f12',
      ' ctrl+z ': 'ctrl+z',
      space: 'space',
      'shift+space': 'shift+space',
      'ctrl+Tab': 'ctrl+tab',
      'alt+Left': 'alt+left',
    };
    for (const [text, want] of Object.entries(same)) expect(canonical(text), text).toBe(want);
  });

  it('never sends the Windows key, under any of its names', () => {
    const windowsKey = ['super', 'super_l', 'super_r', 'win', 'win_l', 'win_r', 'windows', 'windows_l', 'windows_r', 'lwin', 'rwin', 'meta', 'meta_l', 'meta_r', 'cmd', 'command', 'hyper', 'hyper_l', 'hyper_r', 'mod4', 'os', 'os_l', 'os_r', 'logo', 'start'];
    for (const name of windowsKey) {
      // On its own, with a key, after a modifier, and in any letter case.
      for (const keys of [name, `${name}+r`, `r+${name}`, `ctrl+${name}+d`, name.toUpperCase(), `${name[0]?.toUpperCase()}${name.slice(1)}+E`]) {
        expect(reason(keys), keys).toBe('Key combinations with the Windows key are never sent.');
      }
    }
    // A spelling that is not in the table is not the Windows key by another name: it is no key at all.
    for (const keys of ['VK_LWIN+r', 'VK_RWIN', 'LWIN_KEY+r', 'win-r', 'w\u0131n+r', '\uff37in+r', '\uff53uper+r', 's\u200buper+r', 'supe\u0433+r', 'Meta\u00a0+x', 'XF86Launch1', 'KEY_LEFTMETA']) {
      expect(canonical(keys), JSON.stringify(keys)).toBeNull();
    }
  });

  it('refuses the combinations that open Start or Task Manager, or switch windows', () => {
    for (const keys of ['ctrl+Escape', 'Escape+ctrl', 'control_l+esc', 'ctrl+shift+Escape', 'Control_R+Shift_R+ESC']) {
      expect(reason(keys), keys).toMatch(/leaves the app/);
    }
    for (const keys of ['alt+Tab', 'alt+shift+Tab', 'Tab+alt', 'alt+Escape', 'alt+shift+Escape', 'alt_r+tab']) {
      expect(reason(keys), keys).toMatch(/leaves the app/);
    }
    // Alt with a function key: alt+F4 closes the window, and the keyboard is then some other app's.
    for (const keys of ['alt+F4', 'F4+alt', 'alt+shift+F4', 'Alt_R+f4', 'alt+F1', 'alt+F6', 'alt+F8', 'alt+F11', 'alt+shift+F12']) {
      expect(reason(keys), keys).toMatch(/leaves the app/);
    }
    // The letter f is not a function key.
    expect(canonical('alt+f')).toBe('alt+f');
  });

  it('refuses every ctrl+alt combination, alt+space, Print Screen and Caps Lock', () => {
    for (const keys of ['ctrl+alt+Delete', 'ctrl+alt+BackSpace', 'ctrl+alt+g', 'alt+ctrl+g', 'ctrl+alt+shift+k', 'ctrl+alt+F1', 'ctrl+alt+Tab', 'ctrl+alt+Escape']) {
      expect(reason(keys), keys).toMatch(/ctrl\+alt/);
    }
    expect(canonical('alt+space')).toBeNull();
    expect(canonical('alt+shift+space')).toBeNull();
    for (const keys of ['Print', 'alt+Print', 'PrintScreen', 'shift+print', 'caps_lock', 'CapsLock', 'ctrl+caps_lock']) expect(canonical(keys), keys).toBeNull();
  });

  it('refuses modifiers on their own, and more than one key at once', () => {
    for (const keys of ['shift', 'ctrl+shift', 'alt', 'alt+shift', 'Control_L']) expect(reason(keys), keys).toMatch(/modifier/);
    for (const keys of ['a+b', 'ctrl+a+c', 'Return+Return']) expect(canonical(keys), keys).toBeNull();
  });

  it('refuses a name it does not know rather than guessing', () => {
    for (const keys of ['super-r', 'VK_LWIN+r', 'XF86Search', '\uff53uper+r', 'ctrl+', '+s', 'ctrl++s', '', '   ', 'ctrl+\u0441', 'num_lock', 'scroll_lock', 'F13', 'F24', 'F25', 'F0', 'F1.5', 'XF86AudioPlay', 'XF86AudioRaiseVolume', 'AudioMute', 'MediaPlayPause', 'VolumeUp', 'BrowserHome', 'LaunchMail', 'Sleep', 'Power', 'Pause', 'Help', 'KP_1', 'numpad1', 'Multi_key', 'dead_acute', 'ISO_Level3_Shift', 'AltGr', 'ctrl+s\u200b', 'ctrl+s\u0000', 'aa']) {
      expect(canonical(keys), JSON.stringify(keys)).toBeNull();
    }
    for (const notText of [undefined, null, 42, ['ctrl', 's'], { text: 'ctrl+s' }]) expect(canonical(notText)).toBeNull();
    // What comes back never carries the hidden characters it was sent.
    expect(reason('evil\u202ekey')).toBe('"evilkey" isn\'t a key name OtherBench knows.');
    expect(reason(`${'x'.repeat(30)}\u202e${'y'.repeat(30)}`)).not.toMatch(/\u202e/);
  });

  it('takes one combination per action', () => {
    for (const keys of ['ctrl+a ctrl+c', 'ctrl+Escape c m d Return', 'Return Return', 'ctrl+a\tctrl+c', 'ctrl+a\nctrl+c']) {
      expect(reason(keys), JSON.stringify(keys)).toBe('OtherBench sends one key combination per action. Send each one as its own action.');
    }
    // Whitespace Rust and JavaScript disagree about is not a separator at all.
    expect(canonical('super\u0085r')).toBeNull();
    expect(canonical('ctrl+a\ufeffctrl+c')).toBeNull();
    expect(canonical('ctrl+a\u00a0ctrl+c')).toBeNull();
  });

  it("refuses OtherBench's own shortcuts, however they are written", () => {
    expect(canonical('ctrl+shift+space')).toBe('ctrl+shift+space');
    for (const reserved of [['ctrl+shift+space'], ['Ctrl+Shift+Space'], ['CommandOrControl+Shift+Space'], ['Shift + Control + SPACE'], ['alt+f1', 'CTRL+SHIFT+SPACE']]) {
      expect(reason('ctrl+shift+space', reserved), reserved.join(' | ')).toMatch(/OtherBench's own shortcuts/);
      expect(reason('Space+Shift+Control_R', reserved), reserved.join(' | ')).toMatch(/OtherBench's own shortcuts/);
    }
    expect(canonical('ctrl+shift+g', ['Ctrl+Shift+KeyG'])).toBeNull();
    expect(canonical('ctrl+1', ['Control+Digit1'])).toBeNull();
    expect(canonical('ctrl+grave', ['Ctrl+`'])).toBeNull();
    expect(canonical('shift+up', ['Shift+ArrowUp'])).toBeNull();
    // Another combination is not held back by it.
    expect(canonical('ctrl+s', ['Ctrl+Shift+Space'])).toBe('ctrl+s');
    // A shortcut the model could never press anyway (Windows key, Print Screen) or none at all reserves nothing.
    expect(canonical('ctrl+s', ['Super+Space', 'PrintScreen', '', '  '])).toBe('ctrl+s');
  });

  it('sends no key at all while it has not been told what the shortcuts are', () => {
    const unknown = "OtherBench doesn't know the desktop app's shortcuts yet; no key was pressed.";
    expect(SHORTCUTS_UNKNOWN_REASON).toBe(unknown);
    // A modifier combination and a bare key alike: the quick-chat hotkey is free text and can be a bare F9.
    for (const keys of ['ctrl+s', 'shift+Tab', 'alt+Left', 'ctrl+shift+s', 'Shift_R+F10', 's+CONTROL', 'Return', 'F5', 'F9', 'Escape', 'a', 'Tab', 'Delete']) {
      expect(reason(keys, null), keys).toBe(unknown);
    }
    // What is refused anyway is refused for its own reason.
    expect(reason('super+r', null)).toBe('Key combinations with the Windows key are never sent.');
    expect(canonical('Print', null)).toBeNull();
    expect(reason('shift', null)).not.toBe(unknown);
    expect(reason('alt+f4', null)).not.toBe(unknown);
    // An empty list is the caller saying there are none, which is not the same as not knowing.
    expect(canonical('ctrl+s', [])).toBe('ctrl+s');
    expect(canonical('F9', [])).toBe('f9');
  });

  it('takes anything that is not an array as no list: undefined, a string, an object, a number', () => {
    const unknown = SHORTCUTS_UNKNOWN_REASON;
    const odd: unknown[] = [undefined, '', 'Ctrl+Shift+Space', {}, { length: 0 }, { 0: 'F9', length: 1 }, 0, 1, false, true, NaN, Symbol('x'), () => [], new Set<string>(), new Map<string, string>()];
    for (const reserved of odd) {
      for (const keys of ['F9', 'Return', 'ctrl+s', 'a']) {
        // Must refuse, and must not throw ("reserved is not iterable").
        expect(parseKeys(keys, reserved), `${String(reserved)} ${keys}`).toEqual({ ok: false, reason: unknown });
      }
    }
    // Leaving the argument out is the same as not knowing.
    expect((parseKeys as (text: unknown) => ReturnType<typeof parseKeys>)('ctrl+s')).toEqual({ ok: false, reason: unknown });
  });

  it('sends no keys at all while it cannot read one of its own shortcuts', () => {
    for (const reserved of [['Ctrl+Shift+MediaPlayPause'], ['Ctrl+Numpad1'], [42], [null], ['ctrl+a+b'], ['ctrl+\u202e']]) {
      expect(reason('ctrl+s', reserved), JSON.stringify(reserved)).toMatch(/couldn't read one of its own shortcuts/);
    }
  });

  it('exports the names it writes, frozen, for the shell to check its own table against', () => {
    expect(Object.isFrozen(KEY_NAMES)).toBe(true);
    expect(Object.isFrozen(KEY_MODIFIERS)).toBe(true);
    expect(KEY_MODIFIERS).toEqual(['ctrl', 'alt', 'shift']);
    expect(KEY_NAMES).toContain('return');
    expect(KEY_NAMES).toContain('f12');
    expect(KEY_NAMES).not.toContain('f13');
    expect(KEY_NAMES).toContain('z');
    expect(KEY_NAMES).toContain('0');
    for (const never of ['print', 'caps_lock', 'super', 'win', 'ctrl', 'alt', 'shift']) expect(KEY_NAMES).not.toContain(never);
    // Every name it writes reads back as itself.
    for (const name of KEY_NAMES) expect(canonical(name), name).toBe(name);
    for (const name of KEY_NAMES) expect(canonical(`shift+${name}`), name).toBe(`shift+${name}`);
  });

  it('holds a key action to its caps before it reads anything', () => {
    expect(KEY_LIMITS).toEqual({ textLength: 64, keysPerCombo: 4, combosPerAction: 1 });
    expect(Object.isFrozen(KEY_LIMITS)).toBe(true);
    // The text's own length, checked on the text as it came.
    expect(reason(`ctrl+${'s'.repeat(80)}`)).toBe('That is too long to be one key combination (at most 64 characters).');
    expect(reason('s'.repeat(65))).toBe('That is too long to be one key combination (at most 64 characters).');
    expect(reason(`${' '.repeat(63)}ctrl+s`)).toBe('That is too long to be one key combination (at most 64 characters).');
    expect(reason('+'.repeat(1_000_000))).toBe('That is too long to be one key combination (at most 64 characters).');
    expect(canonical(`${' '.repeat(58)}ctrl+s`)).toBe('ctrl+s');
    // Keys per combination: three modifiers and one key.
    expect(canonical('ctrl+shift+s')).toBe('ctrl+shift+s');
    expect(parseKeys('shift+ctrl+shift+F5', [])).toEqual({ ok: true, combos: [['ctrl', 'shift', 'f5']], text: 'ctrl+shift+f5' });
    for (const keys of ['ctrl+shift+ctrl+shift+s', 'ctrl+ctrl+ctrl+ctrl+s', 'a+b+c+d+e', 'shift+shift+shift+shift+shift']) {
      expect(reason(keys), keys).toBe('A key combination is at most 4 keys: up to three modifiers and one key.');
    }
    // One combination per action.
    for (const parsed of [parseKeys('ctrl+s', []), parseKeys('Return', []), parseKeys('ctrl+shift+F5', [])]) {
      expect(parsed.ok && parsed.combos.length).toBe(KEY_LIMITS.combosPerAction);
      expect(parsed.ok && parsed.combos.every((combo) => combo.length <= KEY_LIMITS.keysPerCombo)).toBe(true);
    }
  });
});

describe('a key combination stands on its own', () => {
  it('is always exactly one key with its modifiers, pressed and released as one thing', () => {
    for (const text of ['ctrl+s', 'Return', 'shift+Tab', 'ctrl+shift+F12', 'a', 'alt+Left', 'S+CTRL+SHIFT']) {
      const parsed = parseKeys(text, []);
      if (!parsed.ok) throw new Error(`Expected ${text} to parse`);
      expect(parsed.combos, text).toHaveLength(1);
      const combo = parsed.combos[0] ?? [];
      const key = combo[combo.length - 1];
      expect(KEY_NAMES, text).toContain(key);
      for (const modifier of combo.slice(0, -1)) expect(KEY_MODIFIERS, text).toContain(modifier);
      // Nothing in the result says to hold, press or release: there is only the combination.
      expect(Object.keys(parsed).sort(), text).toEqual(['combos', 'ok', 'text']);
    }
  });

  it('remembers nothing from one call to the next: no modifier carries over', () => {
    // A refused modifier on its own, then a key: the key is not sent with it.
    expect(parseKeys('shift', []).ok).toBe(false);
    expect(parseKeys('ctrl', []).ok).toBe(false);
    expect(parseKeys('a', [])).toEqual({ ok: true, combos: [['a']], text: 'a' });
    // A combination, then a key on its own, then the same combination again: each is read alone.
    expect(parseKeys('ctrl+shift+s', [])).toEqual({ ok: true, combos: [['ctrl', 'shift', 's']], text: 'ctrl+shift+s' });
    expect(parseKeys('s', [])).toEqual({ ok: true, combos: [['s']], text: 's' });
    expect(parseKeys('escape', [])).toEqual({ ok: true, combos: [['escape']], text: 'escape' });
    expect(parseKeys('ctrl+shift+s', [])).toEqual({ ok: true, combos: [['ctrl', 'shift', 's']], text: 'ctrl+shift+s' });
    // What it gives back is a fresh value each time: changing one result changes no later one.
    const first = parseKeys('ctrl+s', []);
    if (first.ok) first.combos[0]?.push('alt', 'tab');
    expect(parseKeys('ctrl+s', [])).toEqual({ ok: true, combos: [['ctrl', 's']], text: 'ctrl+s' });
  });

  it('has no way to hold a key down or let one go', () => {
    for (const text of ['keydown ctrl', 'keyup ctrl', 'hold+ctrl', 'ctrl+down+s', 'press+a', 'release+a', 'ctrl_down', 'shift_up', 'ctrl+', '+ctrl']) {
      const parsed = parseKeys(text, []);
      // `down` is the arrow key and nothing else: ctrl+down+s is two keys, which is refused.
      expect(parsed.ok, text).toBe(false);
    }
    expect(parseKeys('ctrl+down', [])).toEqual({ ok: true, combos: [['ctrl', 'down']], text: 'ctrl+down' });
    expect(parseKeys('up', [])).toEqual({ ok: true, combos: [['up']], text: 'up' });
  });
});

describe('what the audit may keep of a key action', () => {
  const kept = [
    'ctrl+s', 'Ctrl+A', 'alt+a', 'ctrl+shift+z', 'ctrl+1', 'alt+period', 'ctrl+space',
    'Return', 'Enter', 'Tab', 'shift+Tab', 'Escape', 'BackSpace', 'Delete', 'Insert', 'Home', 'End', 'Page_Up', 'Page_Down',
    'Up', 'shift+Down', 'Left', 'Right', 'Menu', 'F1', 'shift+F10', 'F12',
  ];
  const typed = [
    'a', 'Z', 'shift+a', '5', 'shift+5', 'space', 'shift+space',
    'minus', 'equal', 'plus', 'comma', 'period', 'slash', 'semicolon', 'apostrophe', 'bracketleft', 'bracketright', 'backslash', 'grave', 'shift+slash',
  ];

  it('keeps a combination with ctrl or alt and a key that types nothing', () => {
    for (const text of kept) {
      expect(isKeyCombination(text), text).toBe(true);
      expect(isSensitiveKeyText(text), text).toBe(false);
    }
  });

  it('counts a bare or shift-only key that types a character as typed text: a secret can be entered one key action at a time', () => {
    for (const text of typed) {
      expect(isKeyCombination(text), text).toBe(true);
      expect(isSensitiveKeyText(text), text).toBe(true);
    }
  });

  it('counts anything that is not one combination as typed text', () => {
    for (const text of ['hunter2 is my password', 'a b', 'ctrl+s ctrl+v', 'ctrl+alt+a', 'super+r', 'alt+F4', 'shift', 'F13', '', ' ', 'x'.repeat(65), null, undefined, 5, {}, ['a']]) {
      expect(isKeyCombination(text), JSON.stringify(text)).toBe(false);
      expect(isSensitiveKeyText(text), JSON.stringify(text)).toBe(true);
    }
  });

  it('classes every key name there is: on its own it either types a character or it does not', () => {
    const typing = KEY_NAMES.filter((name) => isSensitiveKeyText(name));
    const letters = Array.from('abcdefghijklmnopqrstuvwxyz');
    const digits = Array.from('0123456789');
    expect([...typing].sort()).toEqual([...letters, ...digits, 'space', 'minus', 'equal', 'comma', 'period', 'slash', 'semicolon', 'apostrophe', 'bracketleft', 'bracketright', 'backslash', 'grave'].sort());
    expect(KEY_NAMES.filter((name) => !isSensitiveKeyText(name)).sort()).toEqual(
      ['return', 'tab', 'escape', 'backspace', 'delete', 'insert', 'home', 'end', 'page_up', 'page_down', 'up', 'down', 'left', 'right', 'menu', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)].sort()
    );
    // With ctrl in front none of them is typed text; shift alone changes nothing.
    for (const name of KEY_NAMES) {
      if (name !== 'escape') expect(isSensitiveKeyText(`ctrl+${name}`), name).toBe(false);
      expect(isSensitiveKeyText(`shift+${name}`), name).toBe(isSensitiveKeyText(name));
    }
  });
});
