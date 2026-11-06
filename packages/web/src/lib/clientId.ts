/**
 * A v4-style random id. `crypto.randomUUID` only exists in secure contexts and
 * the app can be served over plain HTTP, so fall back to `getRandomValues`,
 * then to `Math.random`.
 */
export function makeClientId(): string {
  const c: Partial<Crypto> | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** sessionStorage key: this tab's client id. */
export const CLIENT_ID_STORAGE_KEY = 'otherbench.clientId';

/** sessionStorage key: set while a page of this tab shows, cleared as it's hidden (a reload, a close). */
export const CLIENT_ID_LIVE_KEY = 'otherbench.clientIdLive';

/** Marks the id as held by a page that shows, or (false) let go. */
function claim(held: boolean): void {
  try {
    if (held) window.sessionStorage.setItem(CLIENT_ID_LIVE_KEY, '1');
    else window.sessionStorage.removeItem(CLIENT_ID_LIVE_KEY);
  } catch {
    // storage blocked -- the id lasts this load anyway.
  }
}

/**
 * This tab's id, kept in sessionStorage so a reload of the tab keeps it (a
 * note sent before the reload still finds its way back); a new tab gets its
 * own. A duplicated tab copies the other's sessionStorage, id included, so
 * the id is also marked held while its page shows: a reload hides the old
 * page first and keeps the id, while a copy finds it still held by the tab it
 * came from and makes its own. A fresh one each load when storage is blocked.
 */
function tabClientId(): string {
  let id: string | null = null;
  try {
    const stored = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (stored && window.sessionStorage.getItem(CLIENT_ID_LIVE_KEY) === null) id = stored;
  } catch {
    // storage blocked -- this load's own id.
  }
  id ??= makeClientId();
  try {
    window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
  } catch {
    // storage blocked or full -- the id lasts this load.
  }
  claim(true);
  window.addEventListener('pagehide', () => claim(false));
  // Back from the back-forward cache: the page shows again, so it holds the id again.
  window.addEventListener('pageshow', (e) => {
    if ((e).persisted) claim(true);
  });
  return id;
}

/** One random id per browser tab: notes carry it so only the sending tab gets a returned note back. */
export const CLIENT_ID: string = tabClientId();
