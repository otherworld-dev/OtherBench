import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, posix, win32 } from 'node:path';
import type { ShellInfo } from '@otherbench/core/types/terminal.js';

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
  /** An executable's absolute path, or null when it isn't installed. Asynchronous: on Windows it runs `where`. */
  resolve(cmd: string): Promise<string | null>;
  exists(path: string): boolean;
  env: Record<string, string | undefined>;
}

/** The first candidate that is an absolute path: a shell found by a relative path could be a file planted in a folder. */
function firstAbsolute(isAbsolutePath: (p: string) => boolean, ...candidates: (string | null | undefined)[]): string | null {
  return candidates.find((c): c is string => typeof c === 'string' && c !== '' && isAbsolutePath(c)) ?? null;
}

async function windowsShells(probe: ShellProbe): Promise<Omit<ShellOption, 'default'>[]> {
  const out: Omit<ShellOption, 'default'>[] = [];
  const abs = (...c: (string | null | undefined)[]): string | null => firstAbsolute(win32.isAbsolute, ...c);
  // Windows' own shells come from System32 first, so a same-named file earlier on PATH isn't the one that runs.
  const system32 = win32.join(probe.env['SystemRoot'] || 'C:\\Windows', 'System32');
  const inSystem = (rel: string): string | null => {
    const p = win32.join(system32, rel);
    return probe.exists(p) ? p : null;
  };
  const systemPowershell = abs(inSystem('WindowsPowerShell\\v1.0\\powershell.exe'));
  const systemCmd = abs(inSystem('cmd.exe'), probe.env['ComSpec']);
  const systemWsl = abs(inSystem('wsl.exe'));
  // Each PATH lookup is a `where` run, so they go side by side, and only for what System32 doesn't have.
  const onPath = (cmd: string, needed = true): Promise<string | null> => (needed ? probe.resolve(cmd) : Promise.resolve(null));
  const [pwshFound, powershellFound, cmdFound, gitFound, wslFound] = await Promise.all([
    onPath('pwsh'),
    onPath('powershell', !systemPowershell),
    onPath('cmd', !systemCmd),
    onPath('git'),
    onPath('wsl', !systemWsl),
  ]);
  const pwsh = abs(pwshFound);
  if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: [] });
  const powershell = systemPowershell ?? abs(powershellFound);
  if (powershell) out.push({ id: 'powershell', label: 'Windows PowerShell', file: powershell, args: [] });
  const cmd = systemCmd ?? abs(cmdFound);
  if (cmd) out.push({ id: 'cmd', label: 'Command Prompt', file: cmd, args: [] });
  // Git for Windows keeps git.exe in cmd\ (or mingw64\bin\) and bash.exe in bin\ of its install folder.
  const git = abs(gitFound);
  if (git) {
    const up = win32.dirname(win32.dirname(git));
    const bash = [win32.join(up, 'bin', 'bash.exe'), win32.join(win32.dirname(up), 'bin', 'bash.exe')].find((p) => probe.exists(p));
    if (bash) out.push({ id: 'git-bash', label: 'Git Bash', file: bash, args: ['--login', '-i'] });
  }
  const wsl = systemWsl ?? abs(wslFound);
  if (wsl) out.push({ id: 'wsl', label: 'WSL', file: wsl, args: [] });
  return out;
}

async function posixShells(probe: ShellProbe): Promise<Omit<ShellOption, 'default'>[]> {
  const out: Omit<ShellOption, 'default'>[] = [];
  const login = firstAbsolute(posix.isAbsolute, probe.env['SHELL']);
  if (login && probe.exists(login)) out.push({ id: 'default', label: posix.basename(login), file: login, args: ['-l'] });
  const names = ['bash', 'zsh', 'sh'];
  const found = await Promise.all(names.map((name) => probe.resolve(name)));
  names.forEach((name, i) => {
    const file = firstAbsolute(posix.isAbsolute, found[i]);
    if (!file || out.some((s) => s.file === file || s.label === name)) return;
    out.push({ id: name, label: name, file, args: ['-l'] });
  });
  return out;
}

/** This machine's shells in menu order; the first is the default. */
export async function detectShells(probe: ShellProbe): Promise<ShellOption[]> {
  const found = probe.platform === 'win32' ? await windowsShells(probe) : await posixShells(probe);
  return found.map((s, i) => ({ ...s, default: i === 0 }));
}

/** `where`'s first match (the one cmd.exe would run), run from System32 and without blocking; null when there's none. */
function where(cmd: string): Promise<string | null> {
  const file = win32.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'where.exe');
  return new Promise((resolve) => {
    execFile(file, [cmd], { encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      resolve(err ? null : (stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? null));
    });
  });
}

/**
 * A command on PATH: `where` on Windows, a PATH walk elsewhere. Only absolute PATH entries count, and on Windows a
 * match in the server's own working folder is refused unless that folder is on PATH (`where` looks there first).
 */
async function onPath(cmd: string): Promise<string | null> {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d !== '' && isAbsolute(d));
  if (process.platform === 'win32') {
    const found = await where(cmd);
    if (found === null) return null;
    const inCwd = win32.dirname(found).toLowerCase() === process.cwd().toLowerCase();
    const cwdOnPath = dirs.some((d) => win32.resolve(d).toLowerCase() === process.cwd().toLowerCase());
    return inCwd && !cwdOnPath ? null : found;
  }
  for (const dir of dirs) {
    const file = join(dir, cmd);
    if (existsSync(file)) return file;
  }
  return null;
}

/** The real machine. */
export function realShellProbe(): ShellProbe {
  return { platform: process.platform, resolve: onPath, exists: existsSync, env: process.env };
}
