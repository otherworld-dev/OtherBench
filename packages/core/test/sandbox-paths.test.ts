import { describe, expect, it } from 'vitest';
import { normaliseWindowsPath, planMounts, SandboxPathError, sandboxFoldersPrompt, toSandboxPath } from '../src/domain/sandbox-paths.js';

describe('toSandboxPath', () => {
  it.each([
    ['E:\\Git\\Grunt', '/mnt/e/Git/Grunt'],
    ['e:\\Git\\Grunt\\', '/mnt/e/Git/Grunt'],
    ['E:/Git//Grunt/', '/mnt/e/Git/Grunt'],
    ['C:\\', '/mnt/c'],
    ['C:/', '/mnt/c'],
    ["C:\\Users\\Zoë O'Brien\\My Project (old)", "/mnt/c/Users/Zoë O'Brien/My Project (old)"],
  ])('%s -> %s', (win, linux) => {
    expect(toSandboxPath(win)).toBe(linux);
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

  it('says when a folder cannot be used there, and why', () => {
    expect(sandboxFoldersPrompt('\\\\nas\\share', [])).toMatch(/not available in the sandbox \(network/);
  });
});
