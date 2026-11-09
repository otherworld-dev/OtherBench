import { useMemo, useState, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import { promptHistory } from '../lib/promptHistory.js';
import { useChanged } from '../lib/useChanged.js';
import { useOtherBenchStore } from '../state/store.js';

/** A recalled message showing in the box: how far back it is, and the draft to put back. */
export type HistoryBrowsing = { index: number; draft: string };

export interface ComposerHistoryInput {
  chat: Chat;
  /** The store's copy of `chat`, when it has one. */
  storedChat: Chat | undefined;
  parentId: string | null | undefined;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  /** Where the caret goes after the next change of text. */
  caretToRef: RefObject<'start' | 'end' | null>;
}

export interface ComposerHistory {
  browsing: HistoryBrowsing | null;
  setBrowsing: Dispatch<SetStateAction<HistoryBrowsing | null>>;
  stepHistory: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** Up and Down in the composer through this branch's earlier messages, keeping the draft aside to put back. */
export function useComposerHistory({ chat, storedChat, parentId, text, setText, caretToRef }: ComposerHistoryInput): ComposerHistory {
  const messages = useOtherBenchStore((s) => s.messages);
  // Up and Down through this branch's earlier messages: which one is showing, and the draft to put back.
  const history = useMemo(() => promptHistory(messages, parentId ?? (storedChat ?? chat).headMessageId), [messages, parentId, storedChat, chat]);
  const [browsing, setBrowsing] = useState<HistoryBrowsing | null>(null);
  // Another chat (or branch) has its own history.
  if (useChanged([chat.id, parentId])) setBrowsing(null);

  /**
   * Up on the first line shows the previous message, Down on the last line
   * the next, and Down past the newest puts the draft back. Anywhere else
   * the keys move the caret as usual. The caret goes to the start after Up
   * and the end after Down, so pressing again keeps stepping.
   */
  function stepHistory(e: KeyboardEvent<HTMLTextAreaElement>): void {
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return;
    if (e.key === 'ArrowUp') {
      if (el.value.slice(0, el.selectionStart).includes('\n')) return;
      const index = (browsing?.index ?? -1) + 1;
      const recalled = history[index];
      if (recalled === undefined) return;
      e.preventDefault();
      setBrowsing({ index, draft: browsing?.draft ?? text });
      caretToRef.current = 'start';
      setText(recalled);
    } else {
      if (!browsing || el.value.slice(el.selectionEnd).includes('\n')) return;
      e.preventDefault();
      const index = browsing.index - 1;
      caretToRef.current = 'end';
      if (index < 0) {
        setBrowsing(null);
        setText(browsing.draft);
      } else {
        setBrowsing({ ...browsing, index });
        setText(history[index] ?? '');
      }
    }
  }

  return { browsing, setBrowsing, stepHistory };
}
