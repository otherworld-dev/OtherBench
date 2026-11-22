import { useEffect, useEffectEvent, useRef, type JSX, type ReactNode } from 'react';

export interface OverlayProps {
  /** The dialog's accessible name: what the view's heading says. */
  label: string;
  testId: string;
  /**
   * Escape, when nothing inside took it first: a menu, a question or an editor in the view handles its own
   * Escape and stops it there (components/Menu.tsx, ConfirmDialog.tsx). The view decides what it does: close,
   * or ask about unsaved changes first.
   */
  onEscape: () => void;
  /**
   * Puts focus back on whatever had it when the view opened, once it closes. Off for a view that does this
   * itself because it knows a second place to try (ProjectView and AppView: their opener may be a menu item, gone by then).
   */
  restoreFocus?: boolean;
  children: ReactNode;
}

/**
 * The shell of a full-screen view (Settings, Usage, Scheduled tasks, a project's or an app's page): a modal
 * dialog over the whole window. Focus moves into it when it opens, to whatever in it asked for focus (an
 * `autoFocus` field, or the element marked `data-autofocus`), else to the shell, and goes back to the opener
 * when it closes, as ConfirmDialog and Menu do. The rest of the app is `inert` meanwhile, so Tab stays in the view
 * and a screen reader doesn't wander into the chat behind it. Toasts stay usable (`data-overlay-keep`).
 */
export function Overlay({ label, testId, onEscape, restoreFocus = true, children }: OverlayProps): JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null);
  // Read before anything in the view takes focus (an `autoFocus` field does so as it mounts).
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const escape = useEffectEvent(onEscape);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    // Everything beside the view: App mounts it next to the sidebar, the panes and the side panels.
    const made: Element[] = [];
    for (const sibling of shell.parentElement?.children ?? []) {
      if (sibling === shell || sibling.hasAttribute('inert') || sibling.hasAttribute('data-overlay-keep')) continue;
      sibling.setAttribute('inert', '');
      made.push(sibling);
    }
    const active = document.activeElement;
    if (!(active instanceof Node) || !shell.contains(active)) (shell.querySelector<HTMLElement>('[data-autofocus]') ?? shell).focus();
    const back = opener.current;
    return () => {
      for (const el of made) el.removeAttribute('inert');
      // Only when closing left focus nowhere: what closed the view may have sent it somewhere already (a chat it opened).
      const now = document.activeElement;
      if (restoreFocus && back?.isConnected && (now === null || now === document.body)) back.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the view opens and closes; `restoreFocus` is fixed per view.
  }, []);

  // On the window, not the shell: Escape still closes the view when focus has fallen to the page (the focused
  // button went away). Whatever inside handled the key has marked it or stopped it by now.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      escape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div ref={shellRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-testid={testId} className="fixed inset-0 z-30 flex flex-col bg-[var(--bg)] outline-none">
      {children}
    </div>
  );
}
