import { existsSync } from 'node:fs';
import { delimiter, join, posix, win32 } from 'node:path';
import type { ShellInfo } from '@otherbench/core/types/terminal.js';
import { ExecutableNotFoundError, resolveExecutable } from '@otherbench/tools/mcp/spawn.js';

/**
 * The shells a terminal can start on this machine (spec 2026-10-21-code-terminal-design,
 * "Shells"). The client picks one by `id`; `file` and `args` never come from a request.
 */
export interface ShellOption extends ShellInfo {
  file: string;
  args: string[];
}

/** What detection looks at, so tests can describe a machine. */
export interface ShellProbe {
  platform: NodeJS.Platform;
  /** An executable's absolute path, or null when it isn't installed. */
  resolve(cmd: string): string | null;
  exists(path: string): boolean;
  env: Record<string, string | undefined>;
}

function windowsShells(probe: ShellProbe): Omit<ShellOption, 'default'>[] {
  const out: Omit<ShellOption, 'default'>[] = [];
  const pwsh = probe.resolve('pwsh');
  if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: [] });
  const powershell = probe.resolve('powershell');
  if (powershell) out.push({ id: 'powershell', label: 'Windows PowerShell', file: powershell, args: [] });
  const cmd = probe.env['ComSpec'] || probe.resolve('cmd');
  if (cmd) out.push({ id: 'cmd', label: 'Command Prompt', file: cmd, args: [] });
  // Git for Windows keeps git.exe in cmd\ (or mingw64\bin\) and bash.exe in bin\ of its install folder.
  const git = probe.resolve('git');
  if (git) {
    const up = win32.dirname(win32.dirname(git));
    const bash = [win32.join(up, 'bin', 'bash.exe'), win32.join(win32.dirname(up), 'bin', 'bash.exe')].find((p) => probe.exists(p));
    if (bash) out.push({ id: 'git-bash', label: 'Git Bash', file: bash, args: ['--login', '-i'] });
  }
  const wsl = probe.resolve('wsl');
  if (wsl) out.push({ id: 'wsl', label: 'WSL', file: wsl, args: [] });
  return out;
}

function posixShells(probe: ShellProbe): Omit<ShellOption, 'default'>[] {
  const out: Omit<ShellOption, 'default'>[] = [];
  const login = probe.env['SHELL'];
  if (login && probe.exists(login)) out.push({ id: 'default', label: posix.basename(login), file: login, args: ['-l'] });
  for (const name of ['bash', 'zsh', 'sh']) {
    const file = probe.resolve(name);
    if (!file || out.some((s) => s.file === file || s.label === name)) continue;
    out.push({ id: name, label: name, file, args: ['-l'] });
  }
  return out;
}

/** This machine's shells in menu order; the first is the default. */
export function detectShells(probe: ShellProbe): ShellOption[] {
  const found = probe.platform === 'win32' ? windowsShells(probe) : posixShells(probe);
  return found.map((s, i) => ({ ...s, default: i === 0 }));
}

/** A command on PATH: `where` on Windows (resolveExecutable), a PATH walk elsewhere. */
function onPath(cmd: string): string | null {
  if (process.platform === 'win32') {
    try {
      return resolveExecutable(cmd);
    } catch (err) {
      if (err instanceof ExecutableNotFoundError) return null;
      throw err;
    }
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const file = join(dir, cmd);
    if (existsSync(file)) return file;
  }
  return null;
}

/** The real machine. */
export function realShellProbe(): ShellProbe {
  return { platform: process.platform, resolve: onPath, exists: existsSync, env: process.env };
}
