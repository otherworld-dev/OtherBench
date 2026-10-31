import { useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import { ApiError } from '../state/api.js';
import { StartChatError, startChat } from '../state/startChat.js';
import { useOtherBenchStore } from '../state/store.js';
import { useUnsentText } from '../state/unsent.js';

/**
 * Per page (`pendingKey`), the chat a start whose message didn't send made:
 * the retry sends into it rather than making another. Outside the component
 * so it survives the page being left and reopened.
 */
const pendingStarts = new Map<string, string>();

export function resetPendingStartsForTests(): void {
  pendingStarts.clear();
}

/**
 * Where a start box makes its chat: a project page (spec
 * 2026-10-15-project-home-design §4) or an app home (spec
 * 2026-10-20-code-tab-design). `owns` says whether a pending chat still
 * belongs to it; `tabId` is the page's own tab, whose pane shows the chat.
 */
export interface StartTarget {
  pendingKey: string;
  name: string;
  tabId: string;
  owns: (chat: Chat) => boolean;
  create: { projectId: string } | { appId: string };
}

/**
 * The pending chat as it is now, if it can still take a first message: not
 * deleted, archived or moved elsewhere, and still empty. Otherwise it's
 * forgotten and the next send makes a new chat.
 */
function pendingStart(target: StartTarget): Chat | undefined {
  const id = pendingStarts.get(target.pendingKey);
  if (id === undefined) return undefined;
  const chat = useOtherBenchStore.getState().chats.find((c) => c.id === id);
  if (chat && target.owns(chat) && chat.archivedAt === null && chat.headMessageId === null) return chat;
  pendingStarts.delete(target.pendingKey);
  return undefined;
}

/**
 * Puts a chat started from a page in the pane showing that page, leaving
 * focus wherever the user went while it was sending. A pane that has moved on
 * to something else is left alone: the chat waits in the sidebar.
 */
function showInPagePane(tabId: string, chatId: string, stayed: boolean): void {
  const { paneState, focusPane, placeChat, focusComposer } = useOtherBenchStore.getState();
  const at = paneState.panes.indexOf(tabId);
  if (at === -1) return;
  const back = paneState.focusedPane;
  placeChat(at, chatId);
  focusPane(back);
  // Still at the start box: the cursor follows into the chat's own box, for the next message.
  if (stayed && back === at) focusComposer(chatId);
}

/**
 * A box that starts a chat with its first message sent. Enter sends,
 * Shift+Enter is a new line; `submitLabel` adds a button that does the same.
 */
export function StartBox({ target, placeholder, submitLabel }: { target: StartTarget; placeholder?: string; submitLabel?: string }): JSX.Element {
  const [text, setText] = useState('');
  useUnsentText(text);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  async function send(): Promise<void> {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const pending = pendingStart(target);
      const chat = await startChat({ ...target.create, ...(pending ? { chat: pending } : {}), text: body });
      pendingStarts.delete(target.pendingKey);
      setText('');
      // Focus still in the box (or let go, as a disabled button does) means the user didn't go elsewhere.
      const active = document.activeElement;
      showInPagePane(target.tabId, chat.id, active === null || active === document.body || (rootRef.current?.contains(active) ?? false));
    } catch (err) {
      if (err instanceof StartChatError) pendingStarts.set(target.pendingKey, err.chat.id);
      const cause = err instanceof StartChatError ? err.cause : err;
      console.error(`[otherbench-web] failed to start a chat in ${target.pendingKey}:`, cause);
      setError(cause instanceof ApiError ? cause.message : "Couldn't start the chat. Please try again.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  }

  return (
    <div ref={rootRef}>
      <div className="relative">
        <textarea
          aria-label={`Start a chat in ${target.name}`}
          placeholder={placeholder ?? `Start a chat in ${target.name}…`}
          value={text}
          readOnly={sending}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className={`w-full resize-y rounded border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 text-sm read-only:opacity-60 focus:border-[var(--accent)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${submitLabel ? 'pb-10' : ''}`}
        />
        {submitLabel && (
          <button
            type="button"
            disabled={sending || text.trim() === ''}
            onClick={() => void send()}
            className="btn btn-primary absolute bottom-2.5 right-2 px-3 py-1 disabled:opacity-50"
          >
            {submitLabel}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
