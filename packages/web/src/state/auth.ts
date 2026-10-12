import { create } from 'zustand';
import { api, type AuthStatus } from './api.js';

/** What the sign-in gate shows: nothing yet, the app, the login page, or the token message. */
export type AuthGateStatus = 'checking' | 'ready' | 'signed-out' | 'token-needed';

export interface AuthState {
  status: AuthGateStatus;
  /** How the server signs people in; null until asked, or when it couldn't be reached. */
  mode: AuthStatus['mode'] | null;
  info: AuthStatus | null;
  /** Signed out while the app was open (a session ended): the login shows over the app, which stays mounted. */
  overlay: boolean;
  loadStatus(): Promise<void>;
  /**
   * A 401 arrived. Asks the server again whether the session is really gone
   * and shows the login over the app only if so; one check at a time.
   */
  expire(): Promise<void>;
  /** Throws `ApiError` with the server's message ("Wrong password.", "Too many tries. …"). */
  signIn(password: string, remember: boolean): Promise<void>;
  signOut(): Promise<void>;
  signOutEverywhere(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
}

function gateStatus(info: AuthStatus): AuthGateStatus {
  if (info.mode === 'open' || info.signedIn) return 'ready';
  return info.mode === 'token' ? 'token-needed' : 'signed-out';
}

/** The check a 401 starts; one at a time. */
let expiring: Promise<void> | null = null;

type Setter = (partial: Partial<AuthState>) => void;

/**
 * A 401 only means the session is gone if the server still says so: a request
 * already in flight when the cookie was replaced (signing in again, a password
 * change, an event stream reconnecting) gets a 401 for the old one. So ask
 * again, and show the login over the app only when the answer is "sign-in
 * mode, not signed in". If the question itself fails, a 401 in sign-in mode
 * still shows the login. With the mode unknown (the status call failed at
 * load) the answer also decides the mode.
 */
async function recheck(set: Setter, get: () => AuthState): Promise<void> {
  let info: AuthStatus;
  try {
    info = await api.auth.status();
  } catch {
    const { mode, status } = get();
    if (mode === 'login' && status === 'ready') set({ status: 'signed-out', overlay: true });
    return;
  }
  const next = gateStatus(info);
  const { status, overlay } = get();
  // From the running app, a signed-out answer puts the login over it; the login page already up stays as it is.
  set({ info, mode: info.mode, status: next, overlay: next === 'signed-out' ? status === 'ready' || overlay : false });
}

/**
 * Sign-in state (spec 2026-10-12-remote-access §5), kept apart from
 * `useGruntStore` so the desktop app, which never mounts the gate, never
 * touches it.
 */
export const useAuthStore = create<AuthState>()((set, get) => ({
  status: 'checking',
  mode: null,
  info: null,
  overlay: false,

  async loadStatus() {
    try {
      const info = await api.auth.status();
      const status = gateStatus(info);
      set({ info, mode: info.mode, status, overlay: status === 'signed-out' ? get().overlay : false });
    } catch {
      // The server can't be reached: show the app as before, which says so itself.
      set({ status: 'ready', mode: null, info: null, overlay: false });
    }
  },

  expire() {
    const { mode, status } = get();
    // Nothing to do in open or token mode, while `loadStatus` is already asking, or with the login already up
    // (a wrong password answers 401 too).
    if (mode === 'open' || mode === 'token' || status === 'checking' || status === 'signed-out') return Promise.resolve();
    if (expiring) return expiring;
    expiring = recheck(set, get).finally(() => {
      expiring = null;
    });
    return expiring;
  },

  async signIn(password, remember) {
    await api.auth.login(password, remember);
    await get().loadStatus();
  },

  async signOut() {
    try {
      await api.auth.logout();
    } catch {
      // Signed out here either way; the session dies with its cookie's expiry or the next restart.
    }
    set((s) => ({ status: 'signed-out', overlay: false, info: s.info ? { ...s.info, signedIn: false } : s.info }));
  },

  async signOutEverywhere() {
    await api.auth.logoutAll();
    set((s) => ({ status: 'signed-out', overlay: false, info: s.info ? { ...s.info, signedIn: false } : s.info }));
  },

  async changePassword(current, next) {
    await api.auth.changePassword(current, next);
    await get().loadStatus();
  },
}));
