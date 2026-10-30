import { useEffect, useId } from 'react';

/**
 * Which composers hold text that hasn't been sent. The desktop updater never
 * restarts the app while any does (desktop/useUpdateActivity.ts), since a
 * composer keeps its text in its own state and a restart would lose it.
 */
const holding = new Set<string>();
const listeners = new Set<(has: boolean) => void>();

export function hasUnsentText(): boolean {
  return holding.size > 0;
}

/** A composer says whether it holds text; one that unmounts reports `false`. */
export function setUnsent(id: string, has: boolean): void {
  const before = hasUnsentText();
  if (has) holding.add(id);
  else holding.delete(id);
  const after = hasUnsentText();
  if (after !== before) for (const cb of listeners) cb(after);
}

/** Calls `cb` whenever `hasUnsentText()` changes. Returns the unsubscribe. */
export function onUnsentChange(cb: (has: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** A composer's part: reports whether `text` holds anything, and stops counting when the composer unmounts. */
export function useUnsentText(text: string): void {
  const id = useId();
  const has = text.trim() !== '';
  useEffect(() => setUnsent(id, has), [id, has]);
  useEffect(() => () => setUnsent(id, false), [id]);
}
