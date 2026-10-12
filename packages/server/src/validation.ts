import { HTTPException } from 'hono/http-exception';

/** Small, dependency-free request-body validators shared by the route modules. Each throws a 400 `HTTPException` (Hono's built-in error type, which the app's default error handling already converts to a proper JSON response) on a bad value. */

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HTTPException(400, { message: `"${field}" is required and must be a non-empty string.` });
  }
  return value;
}

export function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new HTTPException(400, { message: `"${field}" must be a string or null.` });
  }
  return value;
}

export function optionalNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new HTTPException(400, { message: `"${field}" must be a number or null.` });
  }
  return value;
}

export function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new HTTPException(400, { message: `"${field}" must be a boolean.` });
  }
  return value;
}

export function optionalStringHeadersRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HTTPException(400, { message: `"${field}" must be an object mapping strings to strings.` });
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new HTTPException(400, { message: `"${field}.${key}" must be a string.` });
    }
    result[key] = entry;
  }
  return result;
}

/**
 * Like {@link optionalStringHeadersRecord}, but additionally rejects an
 * empty-string value for any key. Used for `env`/`headers` on
 * `POST /mcp-servers`: unlike `extraHeaders` (plain non-secret metadata,
 * where an empty string is a legitimate value -- see
 * `optionalStringHeadersRecord`'s callers), every value here is about to be
 * written to `SecretStore` and, for `env`, handed to a child process's
 * environment. `resolveSecretRefs` (packages/tools/src/mcp/manager.ts) only
 * ever drops a ref that fails to resolve, never an empty-but-present value,
 * so an empty string stored here would launch the child process with e.g.
 * `GITHUB_TOKEN=""` -- which many MCP servers read as "configured but
 * unauthenticated" rather than failing cleanly. Matches
 * `PATCH /connections/:id`'s rejection of an empty `apiKey`.
 */
export function optionalNonEmptySecretRecord(value: unknown, field: string): Record<string, string> {
  const result = optionalStringHeadersRecord(value, field);
  for (const [key, entry] of Object.entries(result)) {
    if (entry.length === 0) {
      throw new HTTPException(400, { message: `"${field}.${key}" must not be an empty string.` });
    }
  }
  return result;
}

/**
 * Parses `env`/`headers` on `PATCH /mcp-servers/:id`. Like
 * {@link optionalNonEmptySecretRecord}, except a value may also be the
 * literal `null`, meaning "keep whatever secret is already stored under
 * this name" instead of replacing it -- see routes/tools.ts's
 * `applySecretPatch`. A name simply absent from the map is still deleted
 * (the "editing replaces the whole set" contract is unchanged); `null` is
 * the one way to opt a specific name back OUT of that replacement, for a
 * name the caller is re-sending unchanged rather than actually editing.
 * This exists because a client (`McpServerForm`) pre-seeds one row per
 * existing name with its value deliberately left blank (a stored secret's
 * value is never echoed back) -- without a way to say "this one didn't
 * change", the only two options are silently deleting it (the bug this
 * closes) or forcing the user to blindly retype a value they may not even
 * remember.
 */
export function optionalSecretPatchRecord(value: unknown, field: string): Record<string, string | null> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HTTPException(400, { message: `"${field}" must be an object mapping strings to strings or null.` });
  }
  const result: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) {
      result[key] = null;
      continue;
    }
    if (typeof entry !== 'string') {
      throw new HTTPException(400, { message: `"${field}.${key}" must be a string or null.` });
    }
    if (entry.length === 0) {
      throw new HTTPException(400, {
        message: `"${field}.${key}" must not be an empty string -- omit the key to delete it, or send null to keep its existing value.`,
      });
    }
    result[key] = entry;
  }
  return result;
}

/** Validates every element of `value` is a string, defaulting to `[]` when omitted -- shared by `args` (routes/tools.ts) and `toolPolicy.mcpServerIds` (routes/profiles.ts). A non-string entry (e.g. `null`, a number, an object) that round-trips through storage can defeat a downstream `.length === 0` fast-path check or simply never match anything real; rejecting it here keeps the stored array meaningful. */
export function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new HTTPException(400, { message: `"${field}" must be an array of strings.` });
  }
  return value;
}

/** Windows treats a single leading slash (`/foo`) as "absolute" (drive-relative) too, which is exactly the shape a Git-Bash-mangled Windows path takes -- so `looksWindowsAbsolute` deliberately requires a drive letter or a UNC prefix, not just a leading separator. Mirrors the client's identically-named helper (packages/web/src/lib/workspaceRoot.ts), which this is the server-side backstop for. */
function looksWindowsAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

/** Matches the shape Git Bash/MSYS mangles a Windows drive path into (e.g. `E:\Git\Grunt` -> `/e/Git/Grunt`) -- capture group 1 is the drive letter. Mirrors the client's `gitBashMangledMatch` (lib/workspaceRoot.ts). */
function gitBashMangledMatch(value: string): RegExpMatchArray | null {
  return value.match(/^\/([a-zA-Z])(\/|$)/);
}

/**
 * Server-side backstop for `workspaceRoot` (POST/PATCH /chats). Once set,
 * this value is handed straight to `containPath`
 * (packages/core/src/domain/paths.ts) as the root every subsequent fs/shell
 * tool call for that chat is contained within -- and `containPath` itself
 * treats a NON-absolute root as relative to the SERVER PROCESS's own cwd
 * (`resolve()`), not as an error. Without a gate here, an unvalidated ".."
 * silently becomes "every sibling directory of wherever `grunt serve`
 * happened to be launched from", and "demo-workspace" becomes some
 * arbitrary subdirectory of it. The web client's own validator
 * (`validateWorkspaceRoot`, packages/web/src/lib/workspaceRoot.ts) is thorough, but it is
 * client-side only -- a direct API call (curl, another client) bypasses it
 * entirely -- so this is the hard gate the product's whole filesystem/shell
 * tool boundary actually rests on, not a UX nicety duplicated for its own
 * sake. Whitespace-only is rejected outright (a bare string of spaces is
 * truthy and was previously stored verbatim, uncaught by any check).
 */
export function optionalWorkspaceRoot(value: unknown, field: string): string | null | undefined {
  const parsed = optionalNullableString(value, field);
  if (parsed === undefined || parsed === null) return parsed;

  const trimmed = parsed.trim();
  if (trimmed.length === 0) {
    throw new HTTPException(400, { message: `"${field}" must not be blank -- clear it with null instead, or enter a native absolute path.` });
  }

  if (process.platform === 'win32') {
    if (looksWindowsAbsolute(trimmed)) return trimmed;
    const mangled = gitBashMangledMatch(trimmed);
    if (mangled) {
      const drive = mangled[1]!.toUpperCase();
      throw new HTTPException(400, {
        message: `"${field}" looks like a Git-Bash-style path ("${trimmed}") -- this server runs on Windows and needs the native form, e.g. "${drive}:\\...".`,
      });
    }
    throw new HTTPException(400, { message: `"${field}" must be a native absolute Windows path, e.g. "E:\\Git\\Grunt" -- got "${trimmed}".` });
  }

  if (!trimmed.startsWith('/')) {
    throw new HTTPException(400, { message: `"${field}" must be a native absolute path, e.g. "/home/user/project" -- got "${trimmed}".` });
  }
  return trimmed;
}

/** Most hosts a profile's sandbox allowlist may name (spec 2026-10-12-sandbox-design). */
export const MAX_SANDBOX_HOSTS = 200;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Why `entry` (already trimmed and lower-cased) isn't a host pattern the
 * sandbox runtime takes the way Grunt allows: `pypi.org`, `*.example.com`,
 * optionally `:port`; no IP literals, no localhost. Null when it is fine.
 */
export function sandboxHostProblem(entry: string): string | null {
  if (entry.length > 253) return 'is longer than 253 characters';
  let host = entry;
  const withPort = /^(.*):(\d{1,5})$/.exec(entry);
  if (withPort) {
    const port = Number(withPort[2]);
    if (port < 1 || port > 65535 || withPort[2]!.startsWith('0')) return 'has a port outside 1-65535';
    host = withPort[1]!;
  }
  if (host.includes('[') || host.includes(':')) return 'is an IP address; name the host instead';
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  const labels = bare.split('.');
  if (labels.every((l) => /^\d+$/.test(l))) return 'is an IP address; name the host instead';
  if (labels[labels.length - 1] === 'localhost') return 'is this machine, which the sandbox never reaches';
  if (labels.length < 2) return 'must be a full host name like pypi.org';
  if (!labels.every((l) => HOST_LABEL.test(l))) return "isn't a host name pattern (letters, digits, hyphens and dots, optionally starting with *.)";
  return null;
}

/** `toolPolicy.sandboxHosts`: trimmed, lower-cased, de-duplicated and checked. */
export function parseSandboxHosts(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new HTTPException(400, { message: '"toolPolicy.sandboxHosts" must be an array of strings, or null for the defaults.' });
  }
  const hosts = [...new Set(value.map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0))];
  if (hosts.length > MAX_SANDBOX_HOSTS) throw new HTTPException(400, { message: `"toolPolicy.sandboxHosts" may list at most ${MAX_SANDBOX_HOSTS} hosts.` });
  for (const host of hosts) {
    const problem = sandboxHostProblem(host);
    if (problem) throw new HTTPException(400, { message: `"toolPolicy.sandboxHosts": "${host}" ${problem}.` });
  }
  return hosts;
}
