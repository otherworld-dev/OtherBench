import { useEffect, useState, type JSX } from 'react';
import { isSettled, type ChatSendStatus } from '@otherbench/core/domain/chat-sends.js';
import type { ChatSend } from '@otherbench/core/ports/store.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';

const STATUS_WORDS: Record<ChatSendStatus, string> = {
  queued: 'Waiting for the chat to be free',
  running: 'Working',
  replied: 'Replied',
  failed: 'Failed',
  stopped: 'Stopped',
  dropped: 'Dropped',
};

function statusLine(send: ChatSend): string {
  const word = STATUS_WORDS[send.status];
  return (send.status === 'failed' || send.status === 'dropped') && send.reason ? `${word}: ${send.reason}` : word;
}

/**
 * The card under a `message_chats` call (spec 2026-11-06-chat-to-chat-design): one row per chat the reply sent work
 * to, with its app and where it is, each opening that chat, and Stop while any is still out. Re-reads on every
 * send event.
 */
export function ChatSendCard({ chatId, fromMessageId }: { chatId: string; fromMessageId: string }): JSX.Element | null {
  const version = useOtherBenchStore((s) => s.chatSendsVersion);
  const chats = useOtherBenchStore((s) => s.chats);
  const apps = useOtherBenchStore((s) => s.apps);
  const open = useOtherBenchStore((s) => s.setActiveChatId);
  const [sends, setSends] = useState<ChatSend[] | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let live = true;
    api.chatSends
      .forChat(chatId)
      .then(({ sends: all }) => {
        if (live) setSends(all.filter((s) => s.fromMessageId === fromMessageId).sort((a, b) => a.createdAt - b.createdAt));
      })
      .catch((err: unknown) => console.error('[otherbench-web] failed to read the chat sends:', err));
    return () => {
      live = false;
    };
  }, [chatId, fromMessageId, version]);

  if (sends === null || sends.length === 0) return null;
  const out = sends.some((s) => !isSettled(s.status));
  const stop = (): void => {
    setStopping(true);
    api.chatSends
      .stop(fromMessageId)
      .then(({ sends: stopped }) => setSends(stopped))
      .catch((err: unknown) => console.error('[otherbench-web] failed to stop the chat sends:', err))
      .finally(() => setStopping(false));
  };

  return (
    <div data-testid="chat-send-card" className="my-2 rounded border border-[var(--border)] px-3 py-2 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold text-[var(--text)]">Sent work to {sends.length === 1 ? '1 chat' : `${sends.length} chats`}</span>
        {out && (
          <button type="button" disabled={stopping} onClick={stop} className="btn btn-danger px-2 py-0.5">
            Stop
          </button>
        )}
      </div>
      <ul className="space-y-0.5">
        {sends.map((s) => {
          const chat = chats.find((c) => c.id === s.toChatId);
          const app = chat?.appId ? apps.find((a) => a.id === chat.appId)?.name : undefined;
          return (
            <li key={s.id} data-testid="chat-send-row" className="flex flex-wrap items-baseline gap-x-2">
              {chat ? (
                <button type="button" onClick={() => open(s.toChatId)} className="font-medium text-[var(--accent)] hover:underline">
                  {chat.title}
                </button>
              ) : (
                <span className="text-[var(--text-muted)]">A deleted chat</span>
              )}
              {app && <span className="text-[var(--text-muted)]">{app}</span>}
              <span className={s.status === 'failed' ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}>{statusLine(s)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
