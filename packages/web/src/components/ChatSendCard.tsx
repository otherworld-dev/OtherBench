import { useEffect, useState, type JSX } from 'react';
import { isSettled, type ChatSendStatus } from '@otherbench/core/domain/chat-sends.js';
import type { ChatSendView } from '@otherbench/core/ports/store.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';

const STATUS_WORDS: Record<ChatSendStatus, string> = {
  queued: 'Waiting for the chat to be free',
  running: 'Working',
  replied: 'Replied',
  failed: 'Failed',
  stopped: 'Stopped',
  dropped: 'Dropped',
  cancelled: 'Cancelled',
};

/** Waiting for a machine that is off or busy (spec 2026-11-13-chat-sends-across-machines-design). */
const isHeld = (send: ChatSendView): boolean => send.status === 'queued' && send.heldReason !== null;

function statusLine(send: ChatSendView): string {
  if (isHeld(send)) return send.heldReason!;
  const word = STATUS_WORDS[send.status];
  return (send.status === 'failed' || send.status === 'dropped') && send.reason ? `${word}: ${send.reason}` : word;
}

/**
 * The card under a `message_chats` call (spec 2026-11-06-chat-to-chat-design): one row per chat the reply sent work
 * to, with its app, the machine it runs on when that's a paired one, and where it is, each opening that chat, and
 * Stop while any is still out. A send held for a machine that is off says why, with Run here (only when its chat
 * could run on this machine), Wait and Cancel. Re-reads on every send event; its calls reach the machine the chat
 * runs on, so it works from either.
 */
export function ChatSendCard({ chatId, fromMessageId }: { chatId: string; fromMessageId: string }): JSX.Element | null {
  const version = useOtherBenchStore((s) => s.chatSendsVersion);
  const chats = useOtherBenchStore((s) => s.chats);
  const apps = useOtherBenchStore((s) => s.apps);
  const open = useOtherBenchStore((s) => s.setActiveChatId);
  const [sends, setSends] = useState<ChatSendView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  // Closed with no resume and not by a Stop: the sender was cleared (or couldn't carry on), so the replies went nowhere.
  const dropped = !out && sends.some((s) => s.resumedAs === 'none') && !sends.some((s) => s.status === 'stopped');

  /** Runs one of the card's calls, showing what it hands back (this reply's sends) or why it was refused. */
  const act = (call: () => Promise<{ sends: ChatSendView[] }>): void => {
    setBusy(true);
    setError(null);
    call()
      .then(({ sends: all }) => setSends(all.filter((s) => s.fromMessageId === fromMessageId).sort((a, b) => a.createdAt - b.createdAt)))
      .catch((err: unknown) => {
        console.error('[otherbench-web] the send card call failed:', err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div data-testid="chat-send-card" className="my-2 rounded border border-[var(--border)] px-3 py-2 text-xs">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold text-[var(--text)]">Sent work to {sends.length === 1 ? '1 chat' : `${sends.length} chats`}</span>
        {out && (
          <button type="button" disabled={busy} onClick={() => act(() => api.chatSends.stopIn(chatId, fromMessageId))} className="btn btn-danger px-2 py-0.5">
            Stop
          </button>
        )}
      </div>
      <ul className="space-y-1">
        {sends.map((s) => {
          const chat = chats.find((c) => c.id === s.toChatId);
          const appId = chat?.appId ?? s.toAppId;
          const app = appId ? apps.find((a) => a.id === appId)?.name : undefined;
          const held = isHeld(s);
          const name = chat?.title ?? (app ? `A new chat in ${app}` : 'A deleted chat');
          return (
            <li key={s.id} data-testid="chat-send-row" className="space-y-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                {chat ? (
                  <button type="button" onClick={() => open(s.toChatId)} className="font-medium text-[var(--accent)] hover:underline">
                    {chat.title}
                  </button>
                ) : (
                  <span className="text-[var(--text-muted)]">{name}</span>
                )}
                {chat && app && <span className="text-[var(--text-muted)]">{app}</span>}
                {s.machine && <span className="text-[var(--text-muted)]">on {s.machine}</span>}
                <span className={s.status === 'failed' ? 'text-[var(--danger)]' : held ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]'}>{statusLine(s)}</span>
              </div>
              {held && (
                <div className="flex flex-wrap items-center gap-2">
                  {s.canRunHere ? (
                    <button type="button" disabled={busy} onClick={() => act(() => api.chatSends.runHere(chatId, s.id))} className="btn px-2 py-0.5">
                      Run here
                    </button>
                  ) : (
                    <span className="text-[var(--text-muted)]">
                      {s.handoverTried
                        ? `${s.machine ?? 'That machine'} may already have it: its answer didn't arrive.`
                        : `${chat?.title ?? app ?? 'Its chat'}'s folder is only on ${s.machine ?? 'that machine'}.`}
                    </span>
                  )}
                  {!s.heldSeen && (
                    <button type="button" disabled={busy} onClick={() => act(() => api.chatSends.wait(chatId, s.id))} className="btn px-2 py-0.5">
                      Wait
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => act(() => api.chatSends.cancel(chatId, s.id))} className="btn px-2 py-0.5">
                    Cancel
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-1 text-[var(--danger)]">
          {error}
        </p>
      )}
      {dropped && (
        <p data-testid="chat-send-dropped" className="mt-1 text-[var(--text-muted)]">
          The replies were not passed back to this chat: it was cleared, or couldn&rsquo;t carry on, before they came.
        </p>
      )}
    </div>
  );
}
