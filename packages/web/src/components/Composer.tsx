import { useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';

/**
 * Fabricates the local stubs for a just-created turn's messages so the
 * thread updates the instant the request resolves, without waiting for a
 * `GET /chats/:id/messages` round trip -- mirrors exactly what
 * `TurnRunner.run` creates server-side (packages/core/src/domain/turn.ts).
 * Any events that arrived over the still-open SSE connection before this
 * runs are already buffered under these same ids (see store.ts's
 * `applyTurnEvent`) and get folded in the moment `registerMessage` runs.
 */
function buildUserStub(chat: Chat, id: string, parentId: string | null, parts: Part[]): CanonMessage {
  return { id, chatId: chat.id, parentId, role: 'user', parts, status: 'complete', error: null, producedBy: null, createdAt: Date.now() };
}

function buildAssistantStub(chat: Chat, id: string, parentId: string, profile: { id: string; name: string; connectionId: string; modelId: string }): CanonMessage {
  return {
    id,
    chatId: chat.id,
    parentId,
    role: 'assistant',
    parts: [],
    status: 'streaming',
    error: null,
    producedBy: { profileId: profile.id, profileName: profile.name, connectionId: profile.connectionId, modelId: profile.modelId },
    createdAt: Date.now(),
  };
}

export function Composer({ chat }: { chat: Chat }): JSX.Element {
  const profiles = useGruntStore((s) => s.profiles);
  const messages = useGruntStore((s) => s.messages);
  const registerMessage = useGruntStore((s) => s.registerMessage);
  const setHeadMessageId = useGruntStore((s) => s.setHeadMessageId);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>(() => (chat.profileId ? [chat.profileId] : []));
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const primaryProfile = profiles.find((p) => p.id === selectedProfileIds[0]) ?? null;
  const comparedProfiles = selectedProfileIds.slice(1).map((id) => profiles.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);

  const inFlightIds = useMemo(
    () =>
      Object.values(messages)
        .filter((m) => m.chatId === chat.id && m.status === 'streaming')
        .map((m) => m.id),
    [messages, chat.id]
  );
  const isStreaming = inFlightIds.length > 0;

  async function handleStop(): Promise<void> {
    await Promise.all(inFlightIds.map((id) => api.turns.cancel(id).catch((err: unknown) => console.error(`[grunt-web] failed to cancel ${id}:`, err))));
  }

  async function handleSend(): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending || selectedProfileIds.length === 0) return;

    setSending(true);
    const parts: Part[] = [{ type: 'text', text: trimmed }];
    try {
      const result = await api.turns.create(chat.id, { parentId: chat.headMessageId, parts, profileIds: selectedProfileIds });

      registerMessage(buildUserStub(chat, result.userMessageId, chat.headMessageId, parts));
      result.assistantMessageIds.forEach((id, i) => {
        const profile = profiles.find((p) => p.id === selectedProfileIds[i]);
        if (!profile) return;
        registerMessage(buildAssistantStub(chat, id, result.userMessageId, profile));
      });

      const newHead = result.assistantMessageIds[0];
      if (newHead) {
        setHeadMessageId(chat.id, newHead);
        void api.turns.setHead(chat.id, newHead).catch((err: unknown) => console.error('[grunt-web] failed to persist head:', err));
      }

      setText('');
      textareaRef.current?.focus();
    } catch (err) {
      console.error('[grunt-web] failed to send turn:', err);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function togglePickerProfile(id: string): void {
    setSelectedProfileIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-raised)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-sunken)]"
          >
            {primaryProfile ? `${primaryProfile.name} · ${primaryProfile.modelId}` : 'Choose a profile'}
          </button>
          {pickerOpen && (
            <ul role="listbox" aria-label="Profile" className="absolute bottom-full z-10 mb-1 w-56 rounded border border-[var(--border)] bg-[var(--bg-raised)] py-1 shadow-lg">
              {profiles.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={p.id === selectedProfileIds[0]}
                    onClick={() => {
                      setSelectedProfileIds([p.id, ...selectedProfileIds.slice(1).filter((id) => id !== p.id)]);
                      setPickerOpen(false);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-sunken)]"
                  >
                    {p.name} <span className="text-[var(--text-muted)]">· {p.modelId}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {comparedProfiles.map((p) => (
          <span key={p.id} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-muted)]">
            + {p.name}
          </span>
        ))}

        <div className="relative">
          <button
            type="button"
            onClick={() => setComparePickerOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={comparePickerOpen}
            title="Compare against other profiles"
            className="rounded-full border border-dashed border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
          >
            + Compare
          </button>
          {comparePickerOpen && (
            <ul role="listbox" aria-label="Compare profiles" aria-multiselectable="true" className="absolute bottom-full z-10 mb-1 w-56 rounded border border-[var(--border)] bg-[var(--bg-raised)] py-1 shadow-lg">
              {profiles
                .filter((p) => p.id !== selectedProfileIds[0])
                .map((p) => (
                  <li key={p.id}>
                    <label className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-[var(--bg-sunken)]">
                      <input type="checkbox" checked={selectedProfileIds.includes(p.id)} onChange={() => togglePickerProfile(p.id)} />
                      {p.name}
                    </label>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Message"
          placeholder="Message... (Enter to send, Shift+Enter for a newline)"
          rows={2}
          className="min-h-[2.5rem] flex-1 resize-y rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={() => void handleStop()}
            className="rounded bg-[var(--danger)] px-4 py-2 text-sm font-medium text-white"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || text.trim().length === 0 || selectedProfileIds.length === 0}
            className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
