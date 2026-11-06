import { useState } from 'react';

/**
 * True on the render where `deps` differ from the previous render's (each compared with Object.is, as effect
 * dependencies are), so state that belonged to the old values can be reset in that same render:
 *
 *   const switched = useChanged([chat.id]);
 *   if (switched) setError(null);
 *
 * React then renders again before anything is painted, so the old chat's error never shows under the new one.
 * An effect that resets it would paint it once first, then render a second time. This is react.dev's
 * "adjusting some state when a prop changes"; false on the first render, when the state is fresh anyway.
 */
export function useChanged(deps: readonly unknown[]): boolean {
  const [prev, setPrev] = useState(deps);
  const changed = prev.length !== deps.length || prev.some((v, i) => !Object.is(v, deps[i]));
  if (changed) setPrev(deps);
  return changed;
}
