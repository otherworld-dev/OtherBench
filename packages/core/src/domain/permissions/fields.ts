/**
 * Reading one field of a tool call's arguments, for every module of the
 * permission broker (`../permissions.ts`). The arguments are whatever the
 * model or the tool's describeCall sent, so nothing here assumes their shape.
 */

/** `args[key]` whatever it is, for a validator that takes `unknown` (`appKey`). */
export function rawField(args: unknown, key: string): unknown {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[key] : undefined;
}

export function stringField(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
