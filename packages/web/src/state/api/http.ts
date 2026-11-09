/** The fetch and error helpers every `api` area module shares (see `../api.ts`). */
import { apiFetch } from '../transport.js';

export class ApiError extends Error {
  readonly status: number;
  /** The `kind` a refusal's body names (a note's 409: `idle`, `command`, `workspace_unresolved`), when it has one. */
  readonly kind?: string;
  /**
   * The `code` a Code tab route's failure names beside its message (a `CodeErrorCode`), when it has one.
   * A string, not the union: the server may name one this build doesn't know yet.
   */
  readonly code?: string;
  /** git's or gh's own stderr, as-is (already URL-redacted by the server), for `git-failed` and `gh-failed`. */
  readonly stderr?: string;
  constructor(status: number, message: string, kind?: string, extra?: { code?: string; stderr?: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (kind !== undefined) this.kind = kind;
    if (extra?.code !== undefined) this.code = extra.code;
    if (extra?.stderr !== undefined) this.stderr = extra.stderr;
  }
}

/** A string field of an error body, or undefined. */
function bodyString(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== 'object' || !(field in body)) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function errorMessageOf(res: Response, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body && typeof (body).error === 'string') {
    return (body as { error: string }).error;
  }
  return res.statusText || `HTTP ${res.status}`;
}

export async function extractErrorMessage(res: Response): Promise<string> {
  return errorMessageOf(res, await res.json().catch(() => null));
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const code = bodyString(body, 'code');
    const stderr = bodyString(body, 'stderr');
    throw new ApiError(res.status, errorMessageOf(res, body), bodyString(body, 'kind'), {
      ...(code !== undefined ? { code } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
    });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}
export function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}
export function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export function del(path: string): Promise<void> {
  return request<void>(path, { method: 'DELETE' });
}

/**
 * Uploads a single file as `multipart/form-data`. Deliberately NOT built on
 * `request()`/`post()` above: those force `Content-Type: application/json`,
 * which would be wrong here -- a `FormData` body needs the browser's own
 * `multipart/form-data; boundary=...` header, set automatically only when
 * `fetch` is left to infer it from the body (i.e. when `Content-Type` is
 * NOT set explicitly at all).
 */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch(path, { method: 'POST', body: form });
  if (!res.ok) throw new ApiError(res.status, await extractErrorMessage(res));
  return (await res.json()) as T;
}
