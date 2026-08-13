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
