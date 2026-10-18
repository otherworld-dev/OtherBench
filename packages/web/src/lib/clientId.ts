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

/** One random id per browser tab: notes carry it so only the sending tab gets a returned note back. */
export const CLIENT_ID: string = makeClientId();
