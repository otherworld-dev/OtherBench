import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type JSX, type KeyboardEvent } from 'react';
import type { Chat, PublicAttachment } from '@grunt/core/ports/store.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import { CLAUDE_EFFORTS, isClaudeEffort, type ClaudeEffort, type Connection, type Profile } from '@grunt/core/types/config.js';
import { api, ApiError } from '../state/api.js';
import { buildAssistantStub, buildUserStub } from '../state/stubs.js';
import { useGruntStore } from '../state/store.js';
import { AttachmentChip } from './AttachmentChip.js';
import { PlanUsageMeter } from './PlanUsageMeter.js';
import { remoteUnreachable } from '../state/machines.js';

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
 * Per-file upload cap. Mirrors the server's `MAX_ATTACHMENT_BYTES`
 * (packages/server/src/routes/attachments.ts); keep the two in step. Checked
 * here so a far-oversized file is refused before any bytes are sent: the server
 * rejects an over-limit body without draining it, and for a very large one the
 * socket resets before the client can read the 413 message.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const UPLOAD_TOO_LARGE_MESSAGE = 'That upload is too large. Attachments are limited to 25MB per file.';

const EFFORT_LABELS: Record<ClaudeEffort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max' };

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
  /**
   * Set while a compare turn's tabs are open and none has been kept: the name
   * of the reply whose tab is showing, which `parentId` already points at.
   * Shown as a hint so it is clear which reply the next message continues.
   */
  continuesFrom?: string | null;
  /** Told the primary selected profile id whenever it changes (and on mount), so an inline edit elsewhere can use the picker's choice. */
  onPrimaryProfileChange?: (profileId: string | null) => void;
}

/** True when the profile runs through Claude Code (its own tools, needs a workspace) rather than Grunt's tool layer. */
export function isClaudeCodeProfile(profile: Profile, connections: Connection[]): boolean {
  return connections.find((c) => c.id === profile.connectionId)?.kind === 'claude_code';
}

export function Composer({ chat, parentId, continuesFrom = null, onPrimaryProfileChange }: ComposerProps): JSX.Element {
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
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [effortSaving, setEffortSaving] = useState(false);
  const [effortError, setEffortError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The message field starts one line high and grows with its text, up to its max height (then it scrolls).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Attachments already on the server but not yet sent -- left by a reload,
  // or added from outside the composer (desktop `--send`) -- show as chips,
  // so they're sent with the next message rather than forgotten.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(api.attachments.list(chat.id))
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        const unsent = list.filter((a) => a.messageId === null);
        if (unsent.length > 0) setAttachments((prev) => [...prev, ...unsent.filter((a) => !prev.some((p) => p.id === a.id))]);
      })
      .catch((err: unknown) => console.error(`[grunt-web] failed to load unsent attachments for chat ${chat.id}:`, err));
    return () => {
      cancelled = true;
    };
  }, [chat.id]);
  const primaryId = selectedProfileIds[0] ?? null;
  useEffect(() => {
    onPrimaryProfileChange?.(primaryId);
  }, [primaryId, onPrimaryProfileChange]);

  const selectedProfiles = selectedProfileIds.map((id) => profiles.find((p) => p.id === id)).filter((p): p is Profile => !!p);
  // A folder that doesn't resolve on this machine blocks sending until the
  // prompt above the composer is answered (v2 spec §6).
  const folderUnresolved = (storedChat ?? chat).workspaceStatus?.status === 'unresolved';
  // A chat that runs on a machine that can't be reached waits for it, or for Run here (UnreachableBanner).
  const machines = useGruntStore((s) => s.machines);
  const elsewhereUnreachable = remoteUnreachable(machines, storedChat ?? chat);
  const needsWorkspace = !folderUnresolved && !chat.workspaceRoot && selectedProfiles.some((p) => isClaudeCodeProfile(p, connections));
  // Auto mode (spec 2026-10-03-claude-code-auto-mode-design section 2): offered
  // when any selected profile runs through Claude Code; it needs the Claude
  // login, so it's unavailable when every such profile uses an endpoint backend.
  const claudeCodeProfiles = selectedProfiles.filter((p) => isClaudeCodeProfile(p, connections));
  const showAutoToggle = claudeCodeProfiles.length > 0;
  const autoUnavailable = showAutoToggle && claudeCodeProfiles.every((p) => !!connections.find((c) => c.id === p.connectionId)?.baseUrl);
  const autoMode = (storedChat ?? chat).autoMode;
  const autoActive = autoMode && !autoUnavailable;
  const effort = (storedChat ?? chat).effort ?? null;
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

  /** Sets the chat's Claude Code effort optimistically; a failed save reverts only `effort` and shows why. Applies from the next message. */
  async function changeEffort(next: ClaudeEffort | null): Promise<void> {
    if (effortSaving) return;
    const previous = effort;
    const latest = (): Chat => useGruntStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    setEffortError(null);
    setEffortSaving(true);
    upsertChat({ ...latest(), effort: next });
    try {
      upsertChat(await api.chats.patch(chat.id, { effort: next }));
    } catch (err) {
      const current = useGruntStore.getState().chats.find((c) => c.id === chat.id);
      if (current) upsertChat({ ...current, effort: previous });
      setEffortError(err instanceof ApiError ? err.message : "Couldn't change the effort. Please try again.");
    } finally {
      setEffortSaving(false);
    }
  }

  /** Uploads each file in turn, appending it to `attachments` as soon as its own upload resolves -- so a chip for a fast file appears immediately rather than waiting on a slower sibling in the same drop/paste. A file that fails to upload is dropped silently from the composer (logged, not surfaced as a blocking error) rather than left in limbo with no attachment id to send. */
  async function uploadFiles(files: File[]): Promise<void> {
    // A new upload starts a clean slate for any earlier remove-failure
    // message -- it describes an attachment that may not even be in this
    // batch, and leaving it up reads as if the NEW upload just failed.
    setRemoveError(null);
    setUploadError(null);
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setUploadError(UPLOAD_TOO_LARGE_MESSAGE);
        continue;
      }
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
    // The same rules as the Send button, which Enter reaches without: never
    // while a reply is still running (that would start a second reply beside
    // it), and never for Claude Code without a workspace folder.
    if (isStreaming || needsWorkspace || folderUnresolved || elsewhereUnreachable) return;

    setSending(true);
    // A stale remove-failure message from before this send must not linger
    // over the (possibly different) attachments actually being sent now.
    setRemoveError(null);
    setSendError(null);
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
      // The message stays in the box to send again; say why it didn't go.
      setSendError(err instanceof ApiError ? `Couldn't send: ${err.message}` : "Couldn't send the message. Please try again.");
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
      className={`border-t px-3 py-2 ${dragOver ? 'border-[var(--accent)] bg-[var(--bg-sunken)]' : 'border-[var(--border)] bg-[var(--bg-raised)]'}`}
    >
      {uploadError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {uploadError}
        </div>
      )}

      {removeError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {removeError}
        </div>
      )}

      {needsWorkspace && (
        <p role="status" className="mb-1.5 text-xs text-[var(--danger)]">Set a workspace folder to use Claude Code.</p>
      )}

      {autoError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {autoError}
        </div>
      )}

      {effortError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {effortError}
        </div>
      )}

      {sendError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {sendError}
        </div>
      )}

      {continuesFrom && (
        <p role="status" className="mb-1.5 text-xs text-[var(--text-muted)]">
          Sending continues from {continuesFrom}'s reply, the tab you're on. The other replies stay in the tabs.
        </p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        data-testid="composer-file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ''; // so choosing the same file again still fires
          if (files.length > 0) void uploadFiles(files);
        }}
      />

      {/* One box: attachments, the message, and a toolbar of the turn's settings with Send at its end. */}
      <div
        data-composer-box=""
        // A container, so the toolbar can tighten up by the box's own width (a narrow pane, not just a narrow window).
        className="@container rounded border border-[var(--border-strong)] bg-[var(--bg)] focus-within:border-[var(--accent)] focus-within:ring-1 focus-within:ring-[var(--accent)]"
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
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

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label="Message"
          placeholder="Message…"
          title="Enter to send, Shift+Enter for a new line. Drag and drop or paste to attach a file."
          rows={1}
          className="block max-h-48 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2 pb-1 text-sm outline-none"
        />

        {/* One line at any width: the profile name gives way first, everything else keeps its size. */}
        <div className="flex flex-nowrap items-center gap-1.5 px-2 pb-1.5">
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 rounded px-1.5 py-0.5 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
          >
            <span aria-hidden="true">📎</span>
          </button>

          <div className="relative min-w-14 shrink">
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              title={primaryProfile ? `${primaryProfile.name} · ${primaryProfile.modelId}` : undefined}
              className="block max-w-full truncate rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] border-[var(--border-strong)] hover:bg-[var(--bg-sunken)]"
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
                      <span className="label-caps ml-1 text-[0.6875rem] text-[var(--text-faint)]">{isClaudeCodeProfile(p, connections) ? 'CC tools' : 'Grunt tools'}</span>
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
              title={
                autoUnavailable
                  ? 'Auto mode needs the Claude login'
                  : autoActive
                    ? 'Auto mode is on: Claude Code decides routine tool calls; your profile limits still apply.'
                    : 'Let Claude Code decide routine tool calls (from the next turn)'
              }
              onClick={() => void toggleAutoMode()}
              className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] disabled:opacity-50 ${
                autoActive
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]'
                  : 'border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]'
              }`}
            >
              Auto
            </button>
          )}

          {showAutoToggle && (
            <select
              aria-label="Effort"
              value={effort ?? ''}
              disabled={effortSaving}
              title="Effort: how much Claude Code thinks before it answers, from the next message. Default follows your Claude Code settings."
              onChange={(e) => void changeEffort(isClaudeEffort(e.target.value) ? e.target.value : null)}
              className="shrink-0 field-sizing-content rounded-full border border-[var(--border-strong)] bg-[var(--bg)] px-1.5 py-0.5 font-mono text-[0.6875rem] text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] disabled:opacity-50"
            >
              {/* Just the level, to keep the toolbar to one line; the tooltip says what it is. */}
              <option value="">default</option>
              {CLAUDE_EFFORTS.map((level) => (
                <option key={level} value={level}>
                  {EFFORT_LABELS[level]}
                </option>
              ))}
            </select>
          )}

          {comparedProfiles.map((p) => (
            <span key={p.id} className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] border-[var(--border)] text-[var(--text-muted)]">
              + {p.name}
            </span>
          ))}

          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setComparePickerOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={comparePickerOpen}
              aria-label="Compare"
              title="Compare against other profiles"
              className="rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] border-dashed border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
            >
              +
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

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Plan limits belong to the Claude login, so not to a Claude Code profile on an endpoint (Deck #825). */}
            {showAutoToggle && !autoUnavailable && <PlanUsageMeter busy={isStreaming} />}
            {isStreaming ? (
              <button
                type="button"
                onClick={() => void handleStop()}
                className="btn btn-danger bg-[var(--danger)] px-3 py-1 text-[var(--bg)]"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending || (text.trim().length === 0 && attachments.length === 0) || selectedProfileIds.length === 0 || needsWorkspace || folderUnresolved || elsewhereUnreachable}
                className="btn btn-primary px-3 py-1"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
