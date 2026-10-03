import { describe, expect, it } from 'vitest';
import { validateWorkspaceRoot } from './workspaceRoot.js';

describe('validateWorkspaceRoot', () => {
  it('needs a value', () => {
    expect(validateWorkspaceRoot('   ', 'linux')).toBe('Enter a workspace path.');
  });

  it('on a Windows server accepts a drive or UNC path and explains a Git-Bash path', () => {
    expect(validateWorkspaceRoot('E:\\Git\\Grunt', 'win32')).toBeNull();
    expect(validateWorkspaceRoot('\\\\server\\share\\dir', 'win32')).toBeNull();
    expect(validateWorkspaceRoot('/e/Git/Grunt', 'win32')).toContain('"E:\\..."');
    expect(validateWorkspaceRoot('relative', 'win32')).toBe('Enter a native absolute Windows path, e.g. "E:\\Git\\Grunt".');
  });

  it('on a POSIX server accepts only an absolute path', () => {
    expect(validateWorkspaceRoot('/home/me/project', 'linux')).toBeNull();
    expect(validateWorkspaceRoot('project', 'linux')).toBe('Enter a native absolute path, e.g. "/home/user/project".');
  });

  it('before the server platform is known, accepts either absolute form but still rejects a Git-Bash path', () => {
    expect(validateWorkspaceRoot('E:\\Git\\Grunt', null)).toBeNull();
    expect(validateWorkspaceRoot('/home/me/project', null)).toBeNull();
    expect(validateWorkspaceRoot('/e/Git', null)).toMatch(/Git-Bash-style/);
  });
});
