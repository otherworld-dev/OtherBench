import { describe, expect, it } from 'vitest';
import { detectShells, realShellProbe, type ShellProbe } from '../../src/terminal/shells.js';

function probe(platform: NodeJS.Platform, found: Record<string, string>, files: string[] = [], env: Record<string, string> = {}): ShellProbe {
  return {
    platform,
    resolve: async (cmd) => found[cmd] ?? null,
    exists: (path) => files.includes(path),
    env,
  };
}

describe('detectShells', () => {
  it('windows: pwsh is the default when installed', async () => {
    const shells = await detectShells(
      probe('win32', { pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }, [], {
        ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      })
    );
    expect(shells.map((s) => s.id)).toEqual(['pwsh', 'powershell', 'cmd']);
    expect(shells.find((s) => s.default)?.id).toBe('pwsh');
    expect(shells[0]).toMatchObject({ label: 'PowerShell 7', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: [] });
    expect(shells[2]).toMatchObject({ label: 'Command Prompt', file: 'C:\\Windows\\system32\\cmd.exe' });
  });

  it('windows: falls back to Windows PowerShell', async () => {
    const shells = await detectShells(probe('win32', { powershell: 'C:\\ps.exe', cmd: 'C:\\cmd.exe' }));
    expect(shells.find((s) => s.default)).toMatchObject({ id: 'powershell', label: 'Windows PowerShell' });
    expect(shells.find((s) => s.id === 'cmd')?.file).toBe('C:\\cmd.exe');
  });

  it('git bash is found beside git', async () => {
    const shells = await detectShells(probe('win32', { git: 'C:\\Program Files\\Git\\cmd\\git.exe' }, ['C:\\Program Files\\Git\\bin\\bash.exe']));
    expect(shells.find((s) => s.id === 'git-bash')).toEqual({
      id: 'git-bash',
      label: 'Git Bash',
      default: true,
      file: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['--login', '-i'],
    });
  });

  it('missing shells are left out', async () => {
    expect(await detectShells(probe('win32', { git: 'C:\\Git\\cmd\\git.exe' }))).toEqual([]);
    const wsl = await detectShells(probe('win32', { wsl: 'C:\\Windows\\System32\\wsl.exe' }));
    expect(wsl).toEqual([{ id: 'wsl', label: 'WSL', default: true, file: 'C:\\Windows\\System32\\wsl.exe', args: [] }]);
  });

  it('posix uses $SHELL first', async () => {
    const shells = await detectShells(probe('linux', { bash: '/usr/bin/bash', zsh: '/bin/zsh', sh: '/bin/sh' }, ['/bin/zsh'], { SHELL: '/bin/zsh' }));
    expect(shells[0]).toEqual({ id: 'default', label: 'zsh', default: true, file: '/bin/zsh', args: ['-l'] });
    expect(shells.map((s) => s.id)).toEqual(['default', 'bash', 'sh']);
    expect(shells.filter((s) => s.default)).toHaveLength(1);
  });

  it('a shell found by a relative path is left out', async () => {
    const shells = await detectShells(probe('win32', { pwsh: 'pwsh.exe', powershell: '.\\powershell.exe', cmd: 'C:\\Windows\\System32\\cmd.exe' }, [], { ComSpec: 'cmd.exe' }));
    expect(shells.map((s) => s.id)).toEqual(['cmd']);
    expect(await detectShells(probe('linux', { bash: 'bin/bash' }, ['./zsh'], { SHELL: './zsh' }))).toEqual([]);
  });

  it('windows: the system shells come from System32 before PATH', async () => {
    const sys = 'C:\\Windows\\System32';
    const shells = await detectShells(
      probe(
        'win32',
        { powershell: 'C:\\planted\\powershell.exe', cmd: 'C:\\planted\\cmd.exe', wsl: 'C:\\planted\\wsl.exe' },
        [`${sys}\\WindowsPowerShell\\v1.0\\powershell.exe`, `${sys}\\cmd.exe`, `${sys}\\wsl.exe`],
        { SystemRoot: 'C:\\Windows' }
      )
    );
    expect(shells.map((s) => s.file)).toEqual([`${sys}\\WindowsPowerShell\\v1.0\\powershell.exe`, `${sys}\\cmd.exe`, `${sys}\\wsl.exe`]);
  });

  it('posix without $SHELL starts with the first shell found', async () => {
    const shells = await detectShells(probe('darwin', { sh: '/bin/sh' }));
    expect(shells).toEqual([{ id: 'sh', label: 'sh', default: true, file: '/bin/sh', args: ['-l'] }]);
  });

  // `where` takes ~100 ms a go: the lookups run side by side, and none for a shell System32 already has.
  it('windows: looks on PATH all at once, and only for what System32 lacks', async () => {
    const sys = 'C:\\Windows\\System32';
    const asked: string[] = [];
    const pending: (() => void)[] = [];
    const detecting = detectShells({
      platform: 'win32',
      resolve: (cmd) => {
        asked.push(cmd);
        return new Promise((done) => pending.push(() => done(cmd === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null)));
      },
      exists: (path) => [`${sys}\\WindowsPowerShell\\v1.0\\powershell.exe`, `${sys}\\cmd.exe`, `${sys}\\wsl.exe`].includes(path),
      env: { SystemRoot: 'C:\\Windows' },
    });
    await Promise.resolve();
    expect(asked.sort()).toEqual(['git', 'pwsh']);
    for (const done of pending) done();
    expect((await detecting).map((s) => s.id)).toEqual(['pwsh', 'powershell', 'cmd', 'wsl']);
  });
});

describe('realShellProbe', () => {
  it("doesn't block: a PATH lookup is a promise", async () => {
    const found = realShellProbe().resolve('a-command-that-is-not-there-ob');
    expect(found).toBeInstanceOf(Promise);
    expect(await found).toBeNull();
  });
});
