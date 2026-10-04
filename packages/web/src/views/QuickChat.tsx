import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import type { Part } from '@grunt/core/types/messages.js';
import { Message } from '../components/Message.js';
import { hideQuick, onDesktopEvent, openChatInMain } from '../desktop/bridge.js';
import { ApiError, api } from '../state/api.js';
import { buildAssistantStub, buildUserStub } from '../state/stubs.js';
import { useGruntStore } from '../state/store.js';
import { useChatSync } from '../state/useChatSync.js';

/**
 * The quick-chat window (v2 plan, Task 37), opened by the global hotkey: a
 * message box and the reply, in a new chat with the default profile. Follow-ups
 * stay in the same chat. **Expand** hands the chat to the main window and
 * starts afresh next time; `Esc` just hides the window, keeping the chat.
 */
export function QuickChat(): JSX.Element {
  const profiles = useGruntStore((s) => s.profiles);
  const setProfiles = useGruntStore((s) => s.setProfiles);
  const messages = useGruntStore((s) => s.messages);
  const registerMessage = useGruntStore((s) => s.registerMessage);
  const upsertChat = useGruntStore((s) => s.upsertChat);
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
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Couldn't reach the Grunt server."));
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
      hideQuick().catch((err: unknown) => console.error('[grunt-web] failed to hide quick chat:', err));
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

  async function send(): Promise<void> {
    const body = text.trim();
    if (!body || !profile || sending || streaming) return;
    setSending(true);
    setError(null);
    try {
      let current = chat;
      if (!current) {
        current = await api.chats.create({ profileId: profile.id });
        upsertChat(current);
        setChat(current);
      }
      const parentId = thread.at(-1)?.id ?? null;
      const parts: Part[] = [{ type: 'text', text: body }];
      const result = await api.turns.create(current.id, { parentId, parts, profileIds: [profile.id] });
      registerMessage(buildUserStub(current, result.userMessageId, parentId, parts));
      for (const id of result.assistantMessageIds) registerMessage(buildAssistantStub(current, id, result.userMessageId, profile));
      setText('');
    } catch (err) {
      console.error('[grunt-web] quick chat failed to send:', err);
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
    openChatInMain(id).catch((err: unknown) => console.error('[grunt-web] failed to open the chat in the main window:', err));
  }

  return (
    <div className="flex h-screen flex-col gap-2 border border-[var(--border)] bg-[var(--bg-raised)] p-3" data-testid="quick-chat">
      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]" data-tauri-drag-region="">
        <span data-tauri-drag-region="">Quick chat{profile ? ` · ${profile.name}` : ''}</span>
        <button type="button" onClick={expand} disabled={!chat} className="rounded border border-[var(--border)] px-2 py-0.5 disabled:opacity-40">
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
      {!profile && profiles.length === 0 && !error && <p className="text-xs text-[var(--text-muted)]">Set up a profile in Grunt's Settings first.</p>}
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
