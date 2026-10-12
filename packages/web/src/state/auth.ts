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
  /** A 401 arrived: the session is gone. Only meaningful in sign-in mode once signed in. */
  expire(): void;
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
    if (mode === 'login' && status === 'ready') set({ status: 'signed-out', overlay: true });
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
