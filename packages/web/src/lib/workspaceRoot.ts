import { useEffect, useState } from 'react';
import { api } from '../state/api.js';

/**
 * Client-side validation of a workspace folder (a chat's, or a project's),
 * shared by the Inspector's Workspace section and the sidebar's project
 * "Set folder..." form so both say the same thing. The server's
 * `optionalWorkspaceRoot` (packages/server/src/validation.ts) is the hard gate;
 * this is the early, friendlier check.
 */

export const WORKSPACE_ROOT_HELP =
  'Must be a native absolute path on the SERVER machine -- e.g. "E:\\Git\\Grunt" on Windows, "/home/user/project" ' +
  'on Linux/macOS. Not a relative path, and not a Git-Bash-style "/e/Git/Grunt": that form resolves to a path ' +
  'Windows has no notion of, which fails with a confusing ENOENT at tool-call time instead of a clear error here.';

function looksWindowsAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

/** Matches the shape Git Bash/MSYS translates a Windows drive path into (e.g. `E:\Git\Grunt` -> `/e/Git/Grunt`) -- capture group 1 is the drive letter. */
function gitBashMangledMatch(value: string): RegExpMatchArray | null {
  return value.match(/^\/([a-zA-Z])(\/|$)/);
}

/**
 * Validates a workspace root against the SERVER's OWN OS convention, read
 * from `GET /api/health`'s `platform` field (never the browser's -- a
 * workspace root is resolved server-side by `containPath`, so only the
 * server's platform can say what "native absolute" means here). While the
 * platform hasn't loaded yet (`null`), still catches the one shape that is
 * never valid input regardless of platform -- a Git-Bash-mangled Windows
 * path -- but otherwise accepts either native absolute form so a slow/failed
 * health fetch doesn't block entering a path outright.
 */
export function validateWorkspaceRoot(raw: string, serverPlatform: string | null): string | null {
  const value = raw.trim();
  if (value.length === 0) return 'Enter a workspace path.';

  const windowsAbsolute = looksWindowsAbsolute(value);
  const gitBashMangled = gitBashMangledMatch(value);
  const posixAbsolute = value.startsWith('/') && !gitBashMangled;

  if (serverPlatform === 'win32') {
    if (windowsAbsolute) return null;
    if (gitBashMangled) {
      const drive = gitBashMangled[1]!.toUpperCase();
      return `That is a Git-Bash-style path -- the server (running Windows) needs the native form, e.g. "${drive}:\\..." instead of "${value}".`;
    }
    return 'Enter a native absolute Windows path, e.g. "E:\\Git\\Grunt".';
  }

  if (serverPlatform !== null) {
    if (posixAbsolute) return null;
    return 'Enter a native absolute path, e.g. "/home/user/project".';
  }

  if (windowsAbsolute || posixAbsolute) return null;
  if (gitBashMangled) {
    const drive = gitBashMangled[1]!.toUpperCase();
    return `That looks like a Git-Bash-style path. If the server runs on Windows, use "${drive}:\\..." instead of "${value}".`;
  }
  return 'Enter a native absolute path (e.g. "E:\\Git\\Grunt" on Windows, "/home/user/project" on Linux/macOS).';
}

/** The server's `process.platform` from `GET /api/health` (null until it loads, or if it fails). */
export function useServerPlatform(): string | null {
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((h) => {
        if (!cancelled) setPlatform(h.platform);
      })
      .catch((err: unknown) => console.error('[grunt-web] failed to fetch server platform for workspace validation:', err));
    return () => {
      cancelled = true;
    };
  }, []);
  return platform;
}
