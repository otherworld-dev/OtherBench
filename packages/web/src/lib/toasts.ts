import { create } from 'zustand';

/** A short message in the corner of the window (components/Toaster.tsx). */
export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
  /** A saved file's full path: the toast offers "Show in folder". */
  path?: string;
  /** A chat to open: the toast's text becomes a button that opens it. */
  chatId?: string;
}

/** How long a toast stays before it goes on its own. */
export const TOAST_MS = 8000;

interface ToastState {
  toasts: Toast[];
  push(toast: Omit<Toast, 'id'>): number;
  dismiss(id: number): void;
}

let next = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(toast) {
    const id = next++;
    // At most three at a time: the oldest goes first.
    set({ toasts: [...get().toasts, { ...toast, id }].slice(-3) });
    setTimeout(() => get().dismiss(id), TOAST_MS);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

/** Shows a toast from anywhere (outside React too). */
export function toast(t: Omit<Toast, 'id'>): number {
  return useToasts.getState().push(t);
}
