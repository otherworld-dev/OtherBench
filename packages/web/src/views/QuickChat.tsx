import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { Part } from '@otherbench/core/types/messages.js';
import { Message } from '../components/Message.js';
import { hideQuick, onDesktopEvent, openChatInMain } from '../desktop/bridge.js';
import { useWindowFocused } from '../lib/useWindowFocused.js';
import { ApiError, api } from '../state/api.js';
import { StartChatError, startChat } from '../state/startChat.js';
import { buildAssistantStub, buildUserStub } from '../state/stubs.js';
import { useOtherBenchStore } from '../state/store.js';
import { useChatSync } from '../state/useChatSync.js';

/**
 * The quick-chat window (v2 plan, Task 37), opened by the global hotkey: a
 * message box and the reply, in a new chat with the default profile. Follow-ups
 * stay in the same chat. **Expand** hands the chat to the main window and
 * starts afresh next time; `Esc` just hides the window, keeping the chat.
 */
export function QuickChat(): JSX.Element {
  const profiles = useOtherBenchStore((s) => s.profiles);
  const setProfiles = useOtherBenchStore((s) => s.setProfiles);
  const messages = useOtherBenchStore((s) => s.messages);
  const registerMessage = useOtherBenchStore((s) => s.registerMessage);
  const [chat, setChat] = useState<Chat | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useChatSync(chat?.id ?? null);

  useEffect(() => {
    api.profiles
      .list()
      .then(setProfiles)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Couldn't reach the OtherBench server."));
  }, [setProfiles]);

  // Each time the hotkey brings the window up, the cursor goes to the message box.
  useEffect(() => {
    inputRef.current?.focus();
    let off: (() => void) | null = null;
    let disposed = false;
    void onDesktopEvent('quick-shown', () => inputRef.current?.focus()).then((unlisten) => {
      if (disposed) unlisten();
      else off = unlisten;
    });
    // Esc hides the window wherever focus is in it.
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      hideQuick().catch((err: unknown) => console.error('[otherbench-web] failed to hide quick chat:', err));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      disposed = true;
      off?.();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const thread = useMemo(
    () =>
      chat
        ? Object.values(messages)
            .filter((m) => m.chatId === chat.id)
            .sort((a, b) => a.createdAt - b.createdAt || (a.role === 'user' ? -1 : 1))
        : [],
    [messages, chat]
  );
  const streaming = thread.some((m) => m.status === 'streaming');
  const profile = profiles.find((p) => p.isDefault && p.archivedAt === null) ?? profiles.find((p) => p.archivedAt === null) ?? null;

  // A reply read here isn't news in the main window's sidebar: mark the chat read once the latest reply has
  // finished with this window in front. The server marked it unread before the reply's end reached this window.
  const focused = useWindowFocused();
  const lastReplyId = streaming ? null : (thread.findLast((m) => m.role === 'assistant')?.id ?? null);
  const readReplyId = useRef<string | null>(null);
  useEffect(() => {
    if (!chat || !focused || lastReplyId === null || readReplyId.current === lastReplyId) return;
    readReplyId.current = lastReplyId;
    api.chats.patch(chat.id, { unread: false }).catch((err: unknown) => console.error(`[otherbench-web] failed to mark chat ${chat.id} read:`, err));
  }, [chat, focused, lastReplyId]);

  async function send(): Promise<void> {
    const body = text.trim();
    if (!body || !profile || sending || streaming) return;
    setSending(true);
    setError(null);
    try {
      const parentId = thread.at(-1)?.id ?? null;
      if (parentId === null) {
        // The first message: the same create-and-send as a project page's start box.
        try {
          setChat(await startChat({ profileId: profile.id, ...(chat ? { chat } : {}), text: body }));
        } catch (err) {
          if (!(err instanceof StartChatError)) throw err;
          setChat(err.chat); // a retry sends into this chat rather than making another
          throw err.cause;
        }
      } else if (chat) {
        const parts: Part[] = [{ type: 'text', text: body }];
        const result = await api.turns.create(chat.id, { parentId, parts, profileIds: [profile.id] });
        registerMessage(buildUserStub(chat, result.userMessageId, parentId, parts));
        for (const id of result.assistantMessageIds) registerMessage(buildAssistantStub(chat, id, result.userMessageId, profile));
      }
      setText('');
    } catch (err) {
      console.error('[otherbench-web] quick chat failed to send:', err);
      setError(err instanceof ApiError ? err.message : "Couldn't send that. Please try again.");
    } finally {
      setSending(false);
    }
  }

  function expand(): void {
    if (!chat) return;
    const id = chat.id;
    setChat(null);
    setText('');
    openChatInMain(id).catch((err: unknown) => console.error('[otherbench-web] failed to open the chat in the main window:', err));
  }

  return (
    <div className="flex h-screen flex-col gap-2 border border-[var(--border)] bg-[var(--bg-raised)] p-3" data-testid="quick-chat">
      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]" data-tauri-drag-region="">
        <span data-tauri-drag-region="">Quick chat{profile ? ` · ${profile.name}` : ''}</span>
        <button type="button" onClick={expand} disabled={!chat} className="btn px-2 py-0.5">
          Expand
        </button>
      </div>
      {thread.length > 0 && (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto" data-testid="quick-thread">
          {thread.map((m) => (
            <Message key={m.id} message={m} />
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      {!profile && profiles.length === 0 && !error && <p className="text-xs text-[var(--text-muted)]">Set up a profile in OtherBench's Settings first.</p>}
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        aria-label="Quick message"
        placeholder="Ask anything… (Enter to send, Esc to hide)"
        rows={thread.length > 0 ? 2 : 4}
        className={`${thread.length > 0 ? '' : 'flex-1'} resize-none rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]`}
      />
    </div>
  );
}
