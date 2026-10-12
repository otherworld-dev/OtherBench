import { useEffect, useRef } from 'react';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { useViewerStore } from './state.js';

/** The `browser` tool calls in `messages`, with whether their reply is still running. */
export function browserCalls(messages: readonly CanonMessage[]): { messageId: string; callId: string; live: boolean }[] {
  const out: { messageId: string; callId: string; live: boolean }[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool-call' && p.name === 'browser') out.push({ messageId: m.id, callId: p.id, live: m.status === 'streaming' });
    }
  }
  return out;
}

/**
 * Opens the chat's viewer on its browser when a running reply starts using it
 * (spec 2026-10-12-model-browser-design §6), unless the user closed the viewer
 * while that reply was running. Calls already in the chat when it's shown are
 * history, never news.
 */
export function useBrowserAutoOpen(chatId: string | null, messages: readonly CanonMessage[], viewerOpen: boolean): void {
  const seen = useRef<{ chatId: string | null; ids: Set<string> }>({ chatId: null, ids: new Set() });
  const closedDuring = useRef(new Set<string>());
  const wasOpen = useRef(viewerOpen);

  useEffect(() => {
    // The user closed the viewer: every reply running now keeps it closed.
    if (wasOpen.current && !viewerOpen) {
      for (const m of messages) if (m.status === 'streaming') closedDuring.current.add(m.id);
    }
    wasOpen.current = viewerOpen;
  }, [viewerOpen, messages]);

  useEffect(() => {
    if (chatId === null) return;
    const calls = browserCalls(messages);
    if (seen.current.chatId !== chatId) {
      seen.current = { chatId, ids: new Set(calls.map((c) => c.callId)) };
      return;
    }
    for (const c of calls) {
      if (seen.current.ids.has(c.callId)) continue;
      seen.current.ids.add(c.callId);
      if (c.live && !closedDuring.current.has(c.messageId)) useViewerStore.getState().openItem(chatId, { kind: 'browser' });
    }
  }, [chatId, messages]);
}
