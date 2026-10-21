import { describe, expect, it } from 'vitest';
import { detectShells, type ShellProbe } from '../../src/terminal/shells.js';

function probe(platform: NodeJS.Platform, found: Record<string, string>, files: string[] = [], env: Record<string, string> = {}): ShellProbe {
  return {
    platform,
    resolve: (cmd) => found[cmd] ?? null,
    exists: (path) => files.includes(path),
    env,
  };
}

describe('detectShells', () => {
  it('windows: pwsh is the default when installed', () => {
    const shells = detectShells(
      probe('win32', { pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }, [], {
        ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      })
    );
    expect(shells.map((s) => s.id)).toEqual(['pwsh', 'powershell', 'cmd']);
    expect(shells.find((s) => s.default)?.id).toBe('pwsh');
    expect(shells[0]).toMatchObject({ label: 'PowerShell 7', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [] });
    expect(shells[2]).toMatchObject({ label: 'Command Prompt', file: 'C:\\Windows\\system32\\cmd.exe' });
  });

  it('windows: falls back to Windows PowerShell', () => {
    const shells = detectShells(probe('win32', { powershell: 'C:\\ps.exe', cmd: 'C:\\cmd.exe' }));
    expect(shells.find((s) => s.default)).toMatchObject({ id: 'powershell', label: 'Windows PowerShell' });
    expect(shells.find((s) => s.id === 'cmd')?.file).toBe('C:\\cmd.exe');
  });

  it('git bash is found beside git', () => {
    const shells = detectShells(probe('win32', { git: 'C:\\Program Files\\Git\\cmd\\git.exe' }, ['C:\\Program Files\\Git\\bin\\bash.exe']));
    expect(shells.find((s) => s.id === 'git-bash')).toEqual({
      id: 'git-bash',
      label: 'Git Bash',
      default: true,
      file: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
    });
  });

  it('missing shells are left out', () => {
    expect(detectShells(probe('win32', { git: 'C:\\Git\\cmd\\git.exe' }))).toEqual([]);
    const wsl = detectShells(probe('win32', { wsl: 'C:\\Windows\\System32\\wsl.exe' }));
    expect(wsl).toEqual([{ id: 'wsl', label: 'WSL', default: true, file: 'C:\\Windows\\System32\\wsl.exe', args: [] }]);
  });

  it('posix uses $SHELL first', () => {
    const shells = detectShells(probe('linux', { bash: '/usr/bin/bash', zsh: '/bin/zsh', sh: '/bin/sh' }, ['/bin/zsh'], { SHELL: '/bin/zsh' }));
    expect(shells[0]).toEqual({ id: 'default', label: 'zsh', default: true, file: '/bin/zsh', args: ['-l'] });
    expect(shells.map((s) => s.id)).toEqual(['default', 'bash', 'sh']);
    expect(shells.filter((s) => s.default)).toHaveLength(1);
  });

  it('posix without $SHELL starts with the first shell found', () => {
    const shells = detectShells(probe('darwin', { sh: '/bin/sh' }));
    expect(shells).toEqual([{ id: 'sh', label: 'sh', default: true, file: '/bin/sh', args: ['-l'] }]);
  });
});
