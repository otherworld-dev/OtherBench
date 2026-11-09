// --- remote sessions ---------------------------------------------------------

/**
 * A browser signed in through remote access's sign-in mode (migration 037).
 * Local to this machine, never synced. The cookie's token is kept only as its
 * SHA-256; `id` is a separate random id the devices list and Sign out use.
 */
export interface RemoteSession {
  id: string;
  /** SHA-256 of the cookie's token, lowercase hex. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** Signed in with "Keep me signed in on this device". */
  remember: boolean;
  /** The password file's epoch when it was made: a password change ends it. */
  epoch: string;
  /** The address it signed in from. */
  address: string | null;
  /** A short form of its user agent, such as "Chrome on Android". */
  deviceLabel: string;
}

export interface RemoteSessionRepo {
  insert(session: RemoteSession): void;
  byTokenHash(tokenHash: string): RemoteSession | null;
  get(id: string): RemoteSession | null;
  /** Oldest first. */
  list(): RemoteSession[];
  count(): number;
  touch(id: string, lastSeenAt: number): void;
  /** Whether there was a row to delete. */
  delete(id: string): boolean;
}

// --- Web Push subscriptions --------------------------------------------------

/** Which things waiting on the user a device is told about by Web Push. */
export interface PushPrefs {
  /** A tool call, question, plan or prompt waiting for the user. */
  approvals: boolean;
  /** A reply finished or failed. */
  replies: boolean;
  /** A scheduled run ended or didn't start. */
  scheduled: boolean;
}

/**
 * One signed-in device's Web Push subscription (migration 040): the push
 * service URL its browser handed out and the keys its payloads are encrypted
 * to. One per remote session, and gone with it: signing the device out (or
 * its session expiring) deletes the row. Local to this machine, never synced.
 */
export interface PushSubscriptionRecord {
  /** The remote session (`RemoteSession.id`) this device signed in with. */
  sessionId: string;
  /** The push service's https URL for this browser. */
  endpoint: string;
  /** The browser's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string;
  /** The browser's auth secret, base64url (16 bytes). */
  auth: string;
  prefs: PushPrefs;
  createdAt: number;
  updatedAt: number;
}

export interface PushSubscriptionRepo {
  /** Sets the session's subscription; an endpoint held by another session moves to this one. */
  put(sub: PushSubscriptionRecord): void;
  bySession(sessionId: string): PushSubscriptionRecord | null;
  list(): PushSubscriptionRecord[];
  /** Whether there was a row to delete. */
  deleteBySession(sessionId: string): boolean;
  /** For a push service that says the subscription is gone (404/410). */
  deleteByEndpoint(endpoint: string): boolean;
}
