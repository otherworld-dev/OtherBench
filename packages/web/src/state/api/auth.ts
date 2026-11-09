/** Sign-in and Web Push calls and shapes for `api.auth` and `api.push`. */
import { request, post, put, patch, del } from './http.js';

/** What `GET /api/auth/status` says (packages/server/src/remote/auth.ts's `AuthStatusBody`). */
export interface AuthStatus {
  mode: 'open' | 'token' | 'login';
  signedIn: boolean;
  /** Sign-in with OtherBench's own certificate: the login page offers it. */
  caDownload?: boolean;
  session?: { expiresAt: number; remember: boolean };
  remote?: {
    publicUrls: string[];
    tls: { mode: 'auto' | 'files' | 'proxy'; notAfter?: number; caFingerprint?: string; names?: string[] };
    trustProxies: string[];
  };
}

/** Which things waiting on the user this device is told about by Web Push (server: `PushPrefs`). */
export interface PushPrefs {
  approvals: boolean;
  replies: boolean;
  scheduled: boolean;
}

/** `GET /api/push` (server: `PushStatusBody` in routes/push.ts). */
export interface PushStatus {
  available: boolean;
  reason?: string;
  publicKey?: string;
  subscribed: boolean;
  prefs: PushPrefs | null;
}

/** One signed-in browser in Settings → Remote access (server: `SignedInDevice` in remote/auth.ts). */
export interface SignedInDevice {
  id: string;
  /** "Chrome on Android" and the like, read off its user agent. */
  deviceLabel: string;
  address: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  remember: boolean;
  /** This browser's own session. */
  current: boolean;
}

/** Sign-in (spec 2026-10-12-remote-access §3). Asked only in a browser, never in the desktop app. */
export const authApi = {
  status: () => request<AuthStatus>('/auth/status'),
  login: (password: string, remember: boolean) => post<{ expiresAt: number }>('/auth/login', { password, remember }),
  logout: () => post<void>('/auth/logout'),
  logoutAll: () => post<void>('/auth/logout-all'),
  /** Signed-in devices, newest first. */
  sessions: () => request<{ sessions: SignedInDevice[] }>('/auth/sessions'),
  /** Signs one device out; 404 when it already was. */
  endSession: (id: string) => del(`/auth/sessions/${encodeURIComponent(id)}`),
  changePassword: (current: string, next: string) => post<{ expiresAt: number }>('/auth/password', { current, next }),
};

/** Web Push for this signed-in device (server: routes/push.ts). Only in sign-in mode; elsewhere `status` says it isn't available. */
export const pushApi = {
  status: () => request<PushStatus>('/push'),
  subscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, prefs: PushPrefs) =>
    put<{ subscribed: boolean; prefs: PushPrefs }>('/push/subscription', { ...sub, prefs }),
  setPrefs: (prefs: PushPrefs) => patch<{ subscribed: boolean; prefs: PushPrefs | null }>('/push/subscription', { prefs }),
  unsubscribe: () => del('/push/subscription'),
  test: () => post<{ result: 'sent' | 'gone' | 'failed' }>('/push/test'),
  /** This page is showing (or stopped): the server pushes nothing to this device meanwhile. */
  active: (visible: boolean) => post<void>('/push/active', { visible }),
};
