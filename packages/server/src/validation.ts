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
