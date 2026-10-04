import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type JSX, type KeyboardEvent } from 'react';
import type { Chat, PublicAttachment } from '@grunt/core/ports/store.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import type { Connection, Profile } from '@grunt/core/types/config.js';
import { api, ApiError } from '../state/api.js';
import { buildAssistantStub, buildUserStub } from '../state/stubs.js';
import { useGruntStore } from '../state/store.js';
import { AttachmentChip } from './AttachmentChip.js';

/**
 * The `Part` an uploaded attachment becomes on the outgoing message (task
 * 21): `image` for anything with an `image/*` MIME type -- the only shape
 * `toModelMessages`/`TurnRunner`'s capability fallback knows how to embed as
 * real visual content or degrade -- `file` for everything else (PDFs, text,
 * CSVs, ...), which `toModelMessages` sends as file content unconditionally.
 */
function attachmentToPart(attachment: PublicAttachment): Part {
  return attachment.mime.startsWith('image/')
    ? { type: 'image', attachmentId: attachment.id, mime: attachment.mime }
    : { type: 'file', attachmentId: attachment.id, mime: attachment.mime, filename: attachment.filename };
}

/**
 * Reads dropped/pasted files off a `DataTransfer`. Prefers `.files` (what a
 * `drop` event, and a browser pasting an image, both populate) and falls
 * back to walking `.items` (`DataTransferItemList`) for anything that only
 * populated that -- some browsers only fill `.items` on `paste`, not `.files`.
 */
function filesFromDataTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  if (data.files && data.files.length > 0) return Array.from(data.files);
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
}

export interface ComposerProps {
  chat: Chat;
  /**
   * The message id the next turn should be parented on -- the conversation's
   * effective tail, already extended forward through any run of single-child
   * replies (mirrors Thread.tsx's own `tailId`, computed the same way
   * `extendForward` walks a lone reply into `displayPath` for display).
   * Falls back to `chat.headMessageId` when omitted (e.g. call sites, tests
   * included, that don't need the distinction).
   *
   * This has to be separate from `chat.headMessageId` and NOT derived from
   * it in here: `chat.headMessageId` deliberately stays pinned to the
   * previous turn's USER message (never auto-advanced to an assistant reply
   * -- picking a reply is always an explicit "Keep", task 27), but nothing
   * ever shows a Keep control for a single-profile reply (Thread only renders
   * one once `openVariants.length > 1`), so there is no way to advance head
   * itself past a lone reply. Sending the NEXT turn against the raw,
   * un-extended `chat.headMessageId` therefore parents the new user message
   * as a SIBLING of the previous assistant reply rather than a child of it --
   * demoting a real reply to a "⤺ 1 other variant" chip and hiding it from
   * the thread. Found via the task-31 end-to-end smoke path, which is the
   * first place two ordinary single-profile turns were ever sent back to
   * back against a live server in the same chat.
   */
  parentId?: string | null;
  /** Told the primary selected profile id whenever it changes (and on mount), so an inline edit elsewhere can use the picker's choice. */
  onPrimaryProfileChange?: (profileId: string | null) => void;
}

/** True when the profile runs through Claude Code (its own tools, needs a workspace) rather than Grunt's tool layer. */
export function isClaudeCodeProfile(profile: Profile, connections: Connection[]): boolean {
  return connections.find((c) => c.id === profile.connectionId)?.kind === 'claude_code';
}

export function Composer({ chat, parentId, onPrimaryProfileChange }: ComposerProps): JSX.Element {
  const profiles = useGruntStore((s) => s.profiles);
  const connections = useGruntStore((s) => s.connections);
  const messages = useGruntStore((s) => s.messages);
  const registerMessage = useGruntStore((s) => s.registerMessage);
  const setHeadMessageId = useGruntStore((s) => s.setHeadMessageId);
  const upsertChat = useGruntStore((s) => s.upsertChat);
  // The store's copy, so an optimistic toggle shows at once even if the parent
  // hasn't re-rendered with the new chat yet.
  const storedChat = useGruntStore((s) => s.chats.find((c) => c.id === chat.id));

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>(() => (chat.profileId ? [chat.profileId] : []));
  const [attachments, setAttachments] = useState<PublicAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const primaryId = selectedProfileIds[0] ?? null;
  useEffect(() => {
    onPrimaryProfileChange?.(primaryId);
  }, [primaryId, onPrimaryProfileChange]);

  const selectedProfiles = selectedProfileIds.map((id) => profiles.find((p) => p.id === id)).filter((p): p is Profile => !!p);
  const needsWorkspace = !chat.workspaceRoot && selectedProfiles.some((p) => isClaudeCodeProfile(p, connections));
  // Auto mode (spec 2026-10-03-claude-code-auto-mode-design section 2): offered
  // when any selected profile runs through Claude Code; it needs the Claude
  // login, so it's unavailable when every such profile uses an endpoint backend.
  const claudeCodeProfiles = selectedProfiles.filter((p) => isClaudeCodeProfile(p, connections));
  const showAutoToggle = claudeCodeProfiles.length > 0;
  const autoUnavailable = showAutoToggle && claudeCodeProfiles.every((p) => !!connections.find((c) => c.id === p.connectionId)?.baseUrl);
  const autoMode = (storedChat ?? chat).autoMode;
  const autoActive = autoMode && !autoUnavailable;
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

  /** Flips the chat's Auto setting optimistically; a failed save reverts only `autoMode` and shows why. Applies from the next turn. */
  async function toggleAutoMode(): Promise<void> {
    if (autoSaving) return;
    const previous = autoMode;
    const next = !previous;
    const latest = (): Chat => useGruntStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    setAutoError(null);
    setAutoSaving(true);
    upsertChat({ ...latest(), autoMode: next });
    try {
      upsertChat(await api.chats.patch(chat.id, { autoMode: next }));
    } catch (err) {
      const current = useGruntStore.getState().chats.find((c) => c.id === chat.id);
      // A chat removed mid-save must not be re-inserted by the revert.
      if (current) upsertChat({ ...current, autoMode: previous });
      setAutoError(err instanceof ApiError ? err.message : "Couldn't change auto mode. Please try again.");
    } finally {
      setAutoSaving(false);
    }
  }

  /** Uploads each file in turn, appending it to `attachments` as soon as its own upload resolves -- so a chip for a fast file appears immediately rather than waiting on a slower sibling in the same drop/paste. A file that fails to upload is dropped silently from the composer (logged, not surfaced as a blocking error) rather than left in limbo with no attachment id to send. */
  async function uploadFiles(files: File[]): Promise<void> {
    // A new upload starts a clean slate for any earlier remove-failure
    // message -- it describes an attachment that may not even be in this
    // batch, and leaving it up reads as if the NEW upload just failed.
    setRemoveError(null);
    for (const file of files) {
      try {
        const created = await api.attachments.upload(chat.id, file);
        setAttachments((prev) => [...prev, created]);
      } catch (err) {
        console.error(`[grunt-web] failed to upload attachment "${file.name}":`, err);
      }
    }
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(): void {
    setDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragOver(false);
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length > 0) void uploadFiles(files);
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = filesFromDataTransfer(e.clipboardData);
    if (files.length > 0) void uploadFiles(files);
  }

  /**
   * Removing a chip before sending must actually delete the server-side
   * attachment row (and, if orphaned, its blob) -- not just drop it from
   * local state, which would leave the upload behind forever (task 32
   * decision #4). The chip stays put until the DELETE actually succeeds:
   * dropping it optimistically and then failing would desync the composer
   * from the server (the row -- and the part it would become on send --
   * would still exist, with no chip showing it), which is a more confusing
   * failure than just leaving the chip there with an error message.
   *
   * A 404 is treated as success, not a failure to surface (task 32 fix
   * round 1, Minor #9): it means the row is ALREADY gone -- e.g. this same
   * remove already went through and only the local state update raced a
   * second click, or another tab/request deleted it first -- and the
   * chip's only job left is to disappear, not to report an "error" for a
   * row that is, from the user's point of view, already exactly as removed
   * as they wanted.
   */
  async function removeAttachment(id: string): Promise<void> {
    setRemoveError(null);
    try {
      await api.attachments.delete(id);
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setAttachments((prev) => prev.filter((a) => a.id !== id));
        return;
      }
      console.error(`[grunt-web] failed to delete attachment ${id}:`, err);
      setRemoveError(err instanceof ApiError ? err.message : 'Failed to remove the attachment. Please try again.');
    }
  }

  async function handleSend(): Promise<void> {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && attachments.length === 0) || sending || selectedProfileIds.length === 0) return;

    setSending(true);
    // A stale remove-failure message from before this send must not linger
    // over the (possibly different) attachments actually being sent now.
    setRemoveError(null);
    const parts: Part[] = [
      ...(trimmed.length > 0 ? [{ type: 'text', text: trimmed } as Part] : []),
      ...attachments.map(attachmentToPart),
    ];
    // The effective tail to parent this turn on -- see ComposerProps.parentId's
    // doc for why this must NOT just be chat.headMessageId.
    const effectiveParentId = parentId ?? chat.headMessageId;
    try {
      const result = await api.turns.create(chat.id, { parentId: effectiveParentId, parts, profileIds: selectedProfileIds });

      registerMessage(buildUserStub(chat, result.userMessageId, effectiveParentId, parts));
      result.assistantMessageIds.forEach((id, i) => {
        const profile = profiles.find((p) => p.id === selectedProfileIds[i]);
        if (!profile) return;
        registerMessage(buildAssistantStub(chat, id, result.userMessageId, profile));
      });

      // Head always advances to the new USER message, never straight to one
      // of its assistant replies -- picking a reply is an explicit choice
      // (task 27: `POST .../head`), never automatic, even for a single
      // profile. `Thread` walks forward through any run of single-child
      // messages on its own (`extendForward`, packages/core/src/domain/tree.ts),
      // so a single-profile reply still renders immediately; a multi-profile
      // (compare) turn instead surfaces as an open tab strip right after
      // this message, since its several replies are NOT a single-child run.
      setHeadMessageId(chat.id, result.userMessageId);
      void api.turns.setHead(chat.id, result.userMessageId).catch((err: unknown) => console.error('[grunt-web] failed to persist head:', err));

      setText('');
      setAttachments([]);
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
    <div
      data-testid="composer-dropzone"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`border-t p-3 ${dragOver ? 'border-[var(--accent)] bg-[var(--bg-sunken)]' : 'border-[var(--border)] bg-[var(--bg-raised)]'}`}
    >
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
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-[var(--text-faint)]">{isClaudeCodeProfile(p, connections) ? 'CC tools' : 'Grunt tools'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {showAutoToggle && (
          <button
            type="button"
            aria-label="Auto mode"
            aria-pressed={autoActive}
            disabled={autoUnavailable || autoSaving}
            title={autoUnavailable ? 'Auto mode needs the Claude login' : 'Let Claude Code decide routine tool calls (from the next turn)'}
            onClick={() => void toggleAutoMode()}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
              autoActive
                ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]'
            }`}
          >
            Auto
          </button>
        )}

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

      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              filename={a.filename}
              mime={a.mime}
              size={a.size}
              previewUrl={api.attachments.previewable(a.mime) ? api.attachments.contentUrl(a.id) : undefined}
              onRemove={() => void removeAttachment(a.id)}
              removeDisabled={sending}
            />
          ))}
        </div>
      )}

      {removeError && (
        <div role="alert" className="mb-2 text-xs text-[var(--danger)]">
          {removeError}
        </div>
      )}

      {needsWorkspace && (
        <p role="status" className="mb-2 text-xs text-[var(--danger)]">Set a workspace folder to use Claude Code.</p>
      )}

      {autoError && (
        <div role="alert" className="mb-2 text-xs text-[var(--danger)]">
          {autoError}
        </div>
      )}

      {autoActive && (
        <p className="mb-2 text-xs text-[var(--text-muted)]">Auto mode: Claude Code decides routine tool calls; your profile limits still apply.</p>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label="Message"
          placeholder="Message... (Enter to send, Shift+Enter for a newline) -- drag & drop or paste to attach a file"
          rows={2}
          className="min-h-[2.5rem] flex-1 resize-y rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-raised)]"
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
            disabled={sending || (text.trim().length === 0 && attachments.length === 0) || selectedProfileIds.length === 0 || needsWorkspace}
            className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-50"
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
