import { describe, expect, it } from 'vitest';
import { KEY_MODIFIERS, KEY_NAMES, parseKeys } from '../src/domain/computer-keys.js';

function canonical(text: unknown, reserved?: readonly unknown[]): string | null {
  const parsed = parseKeys(text, reserved);
  return parsed.ok ? parsed.text : null;
}

function reason(text: unknown, reserved?: readonly unknown[]): string {
  const parsed = parseKeys(text, reserved);
  if (parsed.ok) throw new Error(`Expected a refusal for ${JSON.stringify(text)}, got ${parsed.text}`);
  return parsed.reason;
}

describe('computer keys', () => {
  it('reads one combination and writes it one way: lower case, modifiers first in a fixed order', () => {
    expect(parseKeys('ctrl+s')).toEqual({ ok: true, combos: [['ctrl', 's']], text: 'ctrl+s' });
    expect(parseKeys('ctrl+shift+s')).toEqual({ ok: true, combos: [['ctrl', 'shift', 's']], text: 'ctrl+shift+s' });
    const same: Record<string, string> = {
      Return: 'return',
      Enter: 'return',
      F5: 'f5',
      'shift+Tab': 'shift+tab',
      'alt+F4': 'alt+f4',
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
      F24: 'f24',
      ' ctrl+z ': 'ctrl+z',
      space: 'space',
      'shift+space': 'shift+space',
      'ctrl+Tab': 'ctrl+tab',
      'alt+Left': 'alt+left',
    };
    for (const [text, want] of Object.entries(same)) expect(canonical(text), text).toBe(want);
  });

  it('never sends the Windows key, under any of its names', () => {
    for (const keys of ['super+r', 'Win_L', 'meta+x', 'win+r', 'ctrl+super+d', 'Super_L', 'WIN+E', 'cmd+space', 'windows', 'lwin+d', 'hyper+a', 'mod4+r']) {
      expect(reason(keys), keys).toBe('Key combinations with the Windows key are never sent.');
    }
  });

  it('refuses the combinations that open Start or Task Manager, or switch windows', () => {
    for (const keys of ['ctrl+Escape', 'Escape+ctrl', 'control_l+esc', 'ctrl+shift+Escape', 'Control_R+Shift_R+ESC']) {
      expect(reason(keys), keys).toMatch(/leaves the app/);
    }
    for (const keys of ['alt+Tab', 'alt+shift+Tab', 'Tab+alt', 'alt+Escape', 'alt+shift+Escape', 'alt_r+tab']) {
      expect(reason(keys), keys).toMatch(/leaves the app/);
    }
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
    for (const keys of ['super-r', 'VK_LWIN+r', 'XF86Search', '\uff53uper+r', 'ctrl+', '+s', 'ctrl++s', '', '   ', 'ctrl+\u0441', 'num_lock', 'scroll_lock', 'F25', 'F0', 'ctrl+s\u200b', 'ctrl+s\u0000', 'aa']) {
      expect(canonical(keys), JSON.stringify(keys)).toBeNull();
    }
    for (const notText of [undefined, null, 42, ['ctrl', 's'], { text: 'ctrl+s' }]) expect(canonical(notText)).toBeNull();
    expect(canonical(`ctrl+${'s'.repeat(80)}`)).toBeNull();
    // What comes back never carries the hidden characters it was sent.
    expect(reason('evil\u202ekey')).toBe('"evilkey" isn\'t a key name Grunt knows.');
    expect(reason(`${'x'.repeat(30)}\u202e${'y'.repeat(30)}`)).not.toMatch(/\u202e/);
  });

  it('takes one combination per action', () => {
    for (const keys of ['ctrl+a ctrl+c', 'ctrl+Escape c m d Return', 'Return Return', 'ctrl+a\tctrl+c', 'ctrl+a\nctrl+c']) {
      expect(reason(keys), JSON.stringify(keys)).toBe('Grunt sends one key combination per action. Send each one as its own action.');
    }
    // Whitespace Rust and JavaScript disagree about is not a separator at all.
    expect(canonical('super\u0085r')).toBeNull();
    expect(canonical('ctrl+a\ufeffctrl+c')).toBeNull();
    expect(canonical('ctrl+a\u00a0ctrl+c')).toBeNull();
  });

  it("refuses Grunt's own shortcuts, however they are written", () => {
    expect(canonical('ctrl+shift+space')).toBe('ctrl+shift+space');
    for (const reserved of [['ctrl+shift+space'], ['Ctrl+Shift+Space'], ['CommandOrControl+Shift+Space'], ['Shift + Control + SPACE'], ['alt+f1', 'CTRL+SHIFT+SPACE']]) {
      expect(reason('ctrl+shift+space', reserved), reserved.join(' | ')).toMatch(/Grunt's own shortcuts/);
      expect(reason('Space+Shift+Control_R', reserved), reserved.join(' | ')).toMatch(/Grunt's own shortcuts/);
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
    expect(KEY_NAMES).toContain('f24');
    expect(KEY_NAMES).toContain('z');
    expect(KEY_NAMES).toContain('0');
    for (const never of ['print', 'caps_lock', 'super', 'win', 'ctrl', 'alt', 'shift']) expect(KEY_NAMES).not.toContain(never);
    // Every name it writes reads back as itself.
    for (const name of KEY_NAMES) expect(canonical(name), name).toBe(name);
    for (const name of KEY_NAMES) expect(canonical(`shift+${name}`), name).toBe(`shift+${name}`);
  });
});
