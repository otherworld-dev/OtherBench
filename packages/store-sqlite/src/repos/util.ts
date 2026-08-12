// Small conversion helpers shared by every repo below. SQLite has no native
// boolean or JSON type: booleans round-trip through INTEGER 0/1, and any
// column typed as a JSON blob in the schema (see migrations/001-initial.ts)
// round-trips through TEXT holding a JSON.stringify'd value. Centralising
// this here means every repo's row<->entity mapping reads the same way.

/** Serialises a value that is never absent (its column is `NOT NULL`). */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

export function fromJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** Serialises a value for a nullable JSON column: `null`/`undefined` stay `NULL`. */
export function toJsonNullable(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export function fromJsonNullable<T>(text: string | null): T | null {
  return text === null ? null : (JSON.parse(text) as T);
}

export function toBool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromBool(value: number): boolean {
  return value !== 0;
}
