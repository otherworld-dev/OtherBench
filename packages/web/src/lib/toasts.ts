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
  /** A button after the text ("Undo"): runs `run`, then the toast goes. */
  action?: { label: string; run: () => void };
}

/** How long a toast stays before it goes on its own. */
export const TOAST_MS = 8000;

/** The least a paused toast gets once the pointer or focus leaves it, so it doesn't vanish as you move away. */
export const TOAST_RESUME_MS = 3000;

interface ToastState {
  toasts: Toast[];
  push(toast: Omit<Toast, 'id'>): number;
  dismiss(id: number): void;
  /** Hovered or focused: the toast stays until `resume` (WCAG 2.2.1), so its buttons can be reached. */
  pause(id: number): void;
  resume(id: number): void;
}

let next = 1;

/** Each toast's timer: running (`timer` set, going at `deadline`) or paused with `remaining` left. */
const clocks = new Map<number, { timer: ReturnType<typeof setTimeout> | null; deadline: number; remaining: number }>();

export const useToasts = create<ToastState>((set, get) => {
  const start = (id: number, ms: number): void => {
    clocks.set(id, { timer: setTimeout(() => get().dismiss(id), ms), deadline: Date.now() + ms, remaining: ms });
  };
  return {
    toasts: [],
    push(toast) {
      const id = next++;
      // At most three at a time: the oldest goes first.
      const toasts = [...get().toasts, { ...toast, id }];
      for (const gone of toasts.slice(0, -3)) forget(gone.id);
      set({ toasts: toasts.slice(-3) });
      start(id, TOAST_MS);
      return id;
    },
    dismiss(id) {
      forget(id);
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
    pause(id) {
      const clock = clocks.get(id);
      if (!clock || clock.timer === null) return;
      clearTimeout(clock.timer);
      clocks.set(id, { timer: null, deadline: 0, remaining: Math.max(0, clock.deadline - Date.now()) });
    },
    resume(id) {
      const clock = clocks.get(id);
      if (!clock || clock.timer !== null) return;
      start(id, Math.max(clock.remaining, TOAST_RESUME_MS));
    },
  };
});

function forget(id: number): void {
  const clock = clocks.get(id);
  if (clock?.timer) clearTimeout(clock.timer);
  clocks.delete(id);
}

/** Shows a toast from anywhere (outside React too). */
export function toast(t: Omit<Toast, 'id'>): number {
  return useToasts.getState().push(t);
}
