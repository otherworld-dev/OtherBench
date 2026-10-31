import type { SecretStore } from '@otherbench/core/ports/secret-store.js';
import type { BrowserContext } from 'playwright-core';

/** What a browser remembers between chats: its cookies, and each site's local storage. */
export type ProfileState = Awaited<ReturnType<BrowserContext['storageState']>>;
type Cookie = ProfileState['cookies'][number];

const SECRET_REF = 'browser-profile';
/** Past this, sites' local storage is dropped, largest first. Cookies, which hold the sign-ins and cookie choices, always stay. */
export const MAX_PROFILE_CHARS = 2_000_000;

const EMPTY: ProfileState = { cookies: [], origins: [] };

const cookieKey = (c: Cookie): string => `${c.domain}\n${c.path}\n${c.name}`;

/**
 * `stored` with what one chat's browser changed since it opened: what it added
 * or changed goes in, and what it removed comes out (signing out has to stick).
 * What other chats saved meanwhile is left alone, so two browsers open at once
 * don't undo each other.
 */
export function mergeProfile(stored: ProfileState, before: ProfileState, after: ProfileState): ProfileState {
  const cookies = new Map(stored.cookies.map((c) => [cookieKey(c), c]));
  const kept = new Set(after.cookies.map(cookieKey));
  for (const c of before.cookies) if (!kept.has(cookieKey(c))) cookies.delete(cookieKey(c));
  for (const c of after.cookies) cookies.set(cookieKey(c), c);
  const origins = new Map(stored.origins.map((o) => [o.origin, o]));
  const left = new Set(after.origins.map((o) => o.origin));
  for (const o of before.origins) if (!left.has(o.origin)) origins.delete(o.origin);
  for (const o of after.origins) origins.set(o.origin, o);
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
}

/** The state to store: under the cap, losing the largest sites' local storage first. */
function capped(state: ProfileState): string {
  const origins = [...state.origins].sort((a, b) => JSON.stringify(a).length - JSON.stringify(b).length);
  let text = JSON.stringify({ cookies: state.cookies, origins });
  while (text.length > MAX_PROFILE_CHARS && origins.length > 0) {
    origins.pop();
    text = JSON.stringify({ cookies: state.cookies, origins });
  }
  return text;
}

/**
 * The model's browser's own sign-ins and cookie choices, kept apart from the
 * person's everyday browser. Sealed in the secret store, since a site's
 * sign-in cookie is as good as its password. Saves run one at a time.
 */
export class BrowserProfile {
  private queue: Promise<unknown> = Promise.resolve();
  /** Counts up on `forget`: a browser opened before it has nothing to save afterwards. */
  private era = 0;

  constructor(private readonly secrets: SecretStore) {}

  get generation(): number {
    return this.era;
  }

  /** The stored state. Unreadable counts as empty, so a damaged profile never stops the browser. */
  async load(): Promise<ProfileState> {
    try {
      const text = await this.secrets.get(SECRET_REF);
      if (text === null) return EMPTY;
      const parsed = JSON.parse(text) as Partial<ProfileState>;
      return { cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [], origins: Array.isArray(parsed.origins) ? parsed.origins : [] };
    } catch (err) {
      console.warn('[browser] the saved sign-ins could not be read, so this browser starts without them:', err);
      return EMPTY;
    }
  }

  /** Folds in what a browser opened in `generation` changed between `before` and `after`. */
  save(generation: number, before: ProfileState, after: ProfileState): Promise<void> {
    return this.enqueue(async () => {
      if (generation !== this.era) return;
      await this.secrets.set(SECRET_REF, capped(mergeProfile(await this.load(), before, after)));
    });
  }

  forget(): Promise<void> {
    this.era += 1;
    return this.enqueue(() => this.secrets.delete(SECRET_REF));
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
