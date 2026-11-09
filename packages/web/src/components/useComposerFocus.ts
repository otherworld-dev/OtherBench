import { useEffect, type RefObject } from 'react';
import { useOtherBenchStore } from '../state/store.js';

/** Whether the focused element is a place to type, or sits in a dialog or menu, so coming back to the window leaves it there. */
function keepsFocus(el: Element | null): boolean {
  if (!(el instanceof HTMLElement) || el === document.body) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(el.type)) return true;
  return el.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;
}

/** Puts the cursor in this chat's message box when the chat is just made, and when the window is come back to. */
export function useComposerFocus(chatId: string, textareaRef: RefObject<HTMLTextAreaElement | null>): void {
  // A chat just made (the "+", a start box) puts the cursor here, so typing can start at once.
  const focusWanted = useOtherBenchStore((s) => s.composerFocus === chatId);
  useEffect(() => {
    if (focusWanted && useOtherBenchStore.getState().takeComposerFocus(chatId)) textareaRef.current?.focus();
  }, [focusWanted, chatId, textareaRef]);

  // Coming back to the window (Alt+Tab, the tray) puts the cursor in the active
  // chat's box, unless it was left somewhere else to type or in a dialog.
  useEffect(() => {
    const onWindowFocus = (): void => {
      const el = textareaRef.current;
      if (!el || useOtherBenchStore.getState().activeChatId !== chatId) return;
      // A pane hidden behind a maximised one keeps its composer mounted.
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return;
      if (keepsFocus(document.activeElement)) return;
      el.focus();
    };
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [chatId, textareaRef]);
}
