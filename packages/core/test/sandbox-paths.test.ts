import { describe, expect, it } from 'vitest';
import { normaliseWindowsPath, planMounts, SandboxPathError, sandboxFoldersPrompt, toSandboxPath } from '../src/domain/sandbox-paths.js';

describe('toSandboxPath', () => {
  it.each([
    ['E:\\Git\\Grunt', '/mnt/e/Git/Grunt'],
    ['e:\\Git\\Grunt', '/mnt/e/Git/Grunt'],
    ['C:\\', '/mnt/c'],
    ["C:\\Users\\Zoë O'Brien\\My Project (old)", "/mnt/c/Users/Zoë O'Brien/My Project (old)"],
  ])('%s -> %s', (win, linux) => {
    expect(toSandboxPath(win)).toBe(linux);
  });

  it.each([
    ['a trailing separator', 'e:\\Git\\Grunt\\', /empty segment or a trailing/],
    ['forward slashes', 'E:/Git/Grunt', /drive letter/],
    ['a repeated separator', 'E:\\Git\\\\Grunt', /empty segment/],
    ['a colon in a name', 'E:\\a:b', /character Windows does not allow/],
    ['a < in a name', 'E:\\a<b', /character Windows does not allow/],
    ['a > in a name', 'E:\\a>b', /character Windows does not allow/],
    ['a quote in a name', 'E:\\a"b', /character Windows does not allow/],
    ['a | in a name', 'E:\\a|b', /character Windows does not allow/],
    ['a ? in a name', 'E:\\a?b', /character Windows does not allow/],
    ['a * in a name', 'E:\\a*b', /character Windows does not allow/],
    ['a trailing dot', 'E:\\a.', /ends in a dot or a space/],
    ['a trailing space', 'E:\\a \\b', /ends in a dot or a space/],
    ['a path over 1024 bytes', `E:\\${'a'.repeat(1030)}`, /longer than 1024 bytes/],
  ])('refuses %s', (_name, win, reason) => {
    expect(() => toSandboxPath(win)).toThrow(SandboxPathError);
    expect(() => toSandboxPath(win)).toThrow(reason);
  });

  it.each([
    ['a comma', 'E:\\a,b'],
    ['a semicolon', 'E:\\a;uid=0'],
  ])('refuses %s with a plain reason', (_name, win) => {
    expect(() => toSandboxPath(win)).toThrow(/commas and semicolons can't be mounted/);
  });

  it('refuses a lone surrogate, but not a surrogate pair', () => {
    expect(() => toSandboxPath('E:\\a\ud800b')).toThrow(/lone surrogate/);
    expect(() => toSandboxPath('E:\\a\udc00')).toThrow(/lone surrogate/);
    expect(() => normaliseWindowsPath('E:/a\ud800')).toThrow(/lone surrogate/);
    expect(toSandboxPath('E:\\a\u{1F4C1}b')).toBe('/mnt/e/a\u{1F4C1}b');
  });

  it('treats U+2028 and U+2029 as ordinary name characters', () => {
    expect(toSandboxPath('D:\\a\u2028b\\c\u2029d')).toBe('/mnt/d/a\u2028b/c\u2029d');
    expect(normaliseWindowsPath('d:/a\u2028b/')).toBe('D:\\a\u2028b');
  });

  it('counts the length in UTF-8 bytes', () => {
    expect(toSandboxPath(`E:\\${'a'.repeat(1020)}`)).toBe(`/mnt/e/${'a'.repeat(1020)}`);
    expect(() => toSandboxPath(`E:\\${'é'.repeat(512)}`)).toThrow(/longer than 1024 bytes/);
  });

  it('allows what the plan needs: spaces, apostrophes, accents, CJK and ordinary punctuation', () => {
    expect(toSandboxPath("D:\\My Docs\\O'Brien (2) & #1 $x! 100%~\\日本語\\café")).toBe("/mnt/d/My Docs/O'Brien (2) & #1 $x! 100%~/日本語/café");
  });

  it.each([
    ['\\\\nas\\share\\project', /network/],
    ['//nas/share/project', /network/],
    ['\\\\?\\C:\\Git', /device/],
    ['\\\\.\\PhysicalDrive0', /device/],
    ['Git\\Grunt', /drive letter/],
    ['/home/adam/project', /drive letter/],
    ['E:', /drive letter/],
    ['E:Git', /drive letter/],
    ['-E:\\a', /drive letter/],
    ['E:\\Git\\..\\Windows', /\.\./],
    ['E:\\Git\nGrunt', /control/],
  ])('refuses %s', (win, reason) => {
    expect(() => toSandboxPath(win)).toThrow(SandboxPathError);
    expect(() => toSandboxPath(win)).toThrow(reason);
  });
});

describe('normaliseWindowsPath', () => {
  it('upper-cases the drive, uses backslashes and drops trailing and repeated separators', () => {
    expect(normaliseWindowsPath('e:/Git//Grunt/')).toBe('E:\\Git\\Grunt');
    expect(normaliseWindowsPath('c:\\')).toBe('C:\\');
    expect(normaliseWindowsPath('C:/')).toBe('C:\\');
  });

  it('checks the tidied path by the same rules as toSandboxPath, so a path it returns always maps', () => {
    for (const bad of ['E:/a:b', 'E:\\a<b', 'E:/a./b', 'E:/a /b', `E:/${'a'.repeat(1030)}`]) expect(() => normaliseWindowsPath(bad)).toThrow(SandboxPathError);
    expect(toSandboxPath(normaliseWindowsPath('e:/Git//Grunt/'))).toBe('/mnt/e/Git/Grunt');
  });
});

describe('planMounts', () => {
  const need = (windowsPath: string, writable = false) => ({ windowsPath, writable });

  it("merges every running chat's folders, read-write if any chat needs it writable, parents first", () => {
    expect(planMounts([[need('E:\\Git\\Grunt'), need('D:\\Refs')], [need('e:\\git\\grunt', true)]])).toEqual([
      { windowsPath: 'D:\\Refs', linuxPath: '/mnt/d/Refs', mode: 'ro' },
      { windowsPath: 'E:\\Git\\Grunt', linuxPath: '/mnt/e/Git/Grunt', mode: 'rw' },
    ]);
  });

  it('drops a folder covered by a mounted parent of the same or wider mode, and keeps one that needs more', () => {
    expect(planMounts([[need('E:\\Git', true), need('E:\\Git\\Grunt\\vendor')]])).toEqual([{ windowsPath: 'E:\\Git', linuxPath: '/mnt/e/Git', mode: 'rw' }]);
    expect(planMounts([[need('E:\\Git'), need('E:\\Git\\Grunt')]])).toEqual([{ windowsPath: 'E:\\Git', linuxPath: '/mnt/e/Git', mode: 'ro' }]);
    expect(planMounts([[need('E:\\Git'), need('E:\\Git\\Grunt', true)]])).toEqual([
      { windowsPath: 'E:\\Git', linuxPath: '/mnt/e/Git', mode: 'ro' },
      { windowsPath: 'E:\\Git\\Grunt', linuxPath: '/mnt/e/Git/Grunt', mode: 'rw' },
    ]);
  });

  it('does not treat a sibling with a common prefix as a parent', () => {
    expect(planMounts([[need('E:\\Git', true), need('E:\\Git2')]]).map((m) => m.linuxPath)).toEqual(['/mnt/e/Git', '/mnt/e/Git2']);
  });

  it('a drive root covers everything on that drive', () => {
    expect(planMounts([[need('E:\\', true), need('E:\\Git')]]).map((m) => m.linuxPath)).toEqual(['/mnt/e']);
  });

  it('is empty with no chats', () => {
    expect(planMounts([])).toEqual([]);
  });
});

describe('sandboxFoldersPrompt', () => {
  it('names the workspace and each folder with its sandbox path', () => {
    const text = sandboxFoldersPrompt('E:\\Git\\Grunt', [
      { root: 'D:\\Refs', access: 'read' },
      { root: 'D:\\Out', access: 'readwrite' },
    ]);
    expect(text).toContain('# Sandbox');
    expect(text).toContain('The workspace E:\\Git\\Grunt is /mnt/e/Git/Grunt in the sandbox');
    expect(text).toContain('D:\\Refs is /mnt/d/Refs in the sandbox (read-only)');
    expect(text).toContain('D:\\Out is /mnt/d/Out in the sandbox.');
  });

  it("maps each folder's real path when given a way to find it, and still names the folder as it was given", () => {
    const text = sandboxFoldersPrompt('e:\\git\\grunt', [{ root: 'Z:\\Docs', access: 'read' }], (p) => (p === 'e:\\git\\grunt' ? 'E:\\Git\\Grunt' : '\\\\nas\\docs'));
    expect(text).toContain('The workspace e:\\git\\grunt is /mnt/e/Git/Grunt in the sandbox');
    expect(text).toMatch(/Z:\\Docs is not available in the sandbox \(network/);
  });

  it('says when a folder cannot be used there, and why', () => {
    expect(sandboxFoldersPrompt('\\\\nas\\share', [])).toMatch(/not available in the sandbox \(network/);
  });
});
