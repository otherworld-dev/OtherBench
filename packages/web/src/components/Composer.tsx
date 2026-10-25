import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type JSX, type KeyboardEvent } from 'react';
import type { Chat, PublicAttachment } from '@otherbench/core/ports/store.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import { CLAUDE_EFFORTS, isClaudeEffort, type ClaudeEffort, type Connection, type Profile } from '@otherbench/core/types/config.js';
import { ESCAPE_STOPS_REPLY_ATTR } from '../lib/escapeStopsReply.js';
import { promptHistory } from '../lib/promptHistory.js';
import { useStopReply } from '../state/useStopReply.js';
import { CLIENT_ID } from '../lib/clientId.js';
import { api, ApiError } from '../state/api.js';
import { buildAssistantStub, buildUserStub } from '../state/stubs.js';
import { useOtherBenchStore } from '../state/store.js';
import { CommandMenu, commandOptionId, filterCommands } from './CommandMenu.js';
import { useChatCommands } from '../state/useChatCommands.js';
import { parseContextCommand, type CommandRow } from '@otherbench/core/domain/context-lines.js';
import { AttachmentChip } from './AttachmentChip.js';
import { PlanUsageMeter } from './PlanUsageMeter.js';
import { remoteUnreachable } from '../state/machines.js';

/** An attachment chip in the box: an upload, or one a returned note brought back (whose size isn't known). */
type ChipAttachment = Pick<PublicAttachment, 'id' | 'filename' | 'mime'> & { size?: number };

/** Said when a command is sent while a reply runs (the server's own refusal says the same). */
const COMMAND_MID_REPLY = 'Wait for the reply to finish, or stop it, before sending a command.';
/** Said above the box when a message sent while a reply ran comes back into it. */
const NOTE_RETURNED = "Not sent: the reply ended before it was read. It's back in the box.";

/** Whether typed text is a command: /clear or /compact (and their aliases), or a Claude Code command the `/` menu offers. */
function isCommandText(text: string, commands: CommandRow[]): boolean {
  if (parseContextCommand(text)) return true;
  const name = /^\/(\S+)/.exec(text.trim())?.[1]?.toLowerCase();
  return name !== undefined && commands.some((c) => [c.name, ...c.aliases].some((n) => n.toLowerCase() === name));
}

/**
 * The `Part` an uploaded attachment becomes on the outgoing message (task
 * 21): `image` for anything with an `image/*` MIME type -- the only shape
 * `toModelMessages`/`TurnRunner`'s capability fallback knows how to embed as
 * real visual content or degrade -- `file` for everything else (PDFs, text,
 * CSVs, ...), which `toModelMessages` sends as file content unconditionally.
 */
function attachmentToPart(attachment: ChipAttachment): Part {
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

/** True when the profile runs through Claude Code (its own tools, needs a workspace) rather than OtherBench's tool layer. */
export function isClaudeCodeProfile(profile: Profile, connections: Connection[]): boolean {
  return connections.find((c) => c.id === profile.connectionId)?.kind === 'claude_code';
}

export function Composer({ chat, parentId, continuesFrom = null, onPrimaryProfileChange }: ComposerProps): JSX.Element {
  const profiles = useOtherBenchStore((s) => s.profiles);
  const connections = useOtherBenchStore((s) => s.connections);
  const messages = useOtherBenchStore((s) => s.messages);
  const registerMessage = useOtherBenchStore((s) => s.registerMessage);
  const setHeadMessageId = useOtherBenchStore((s) => s.setHeadMessageId);
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
  // The store's copy, so an optimistic toggle shows at once even if the parent
  // hasn't re-rendered with the new chat yet.
  const storedChat = useOtherBenchStore((s) => s.chats.find((c) => c.id === chat.id));

  const [text, setText] = useState('');
  // Up and Down through this branch's earlier messages: which one is showing, and the draft to put back.
  const history = useMemo(() => promptHistory(messages, parentId ?? (storedChat ?? chat).headMessageId), [messages, parentId, storedChat, chat]);
  const [browsing, setBrowsing] = useState<{ index: number; draft: string } | null>(null);
  const caretTo = useRef<'start' | 'end' | null>(null);
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>(() => (chat.profileId ? [chat.profileId] : []));
  const [attachments, setAttachments] = useState<ChipAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [effortSaving, setEffortSaving] = useState(false);
  const [effortError, setEffortError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [noteReturned, setNoteReturned] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The `/` menu: open while the box holds just `/name` (no space yet) and a selected profile runs Claude Code.
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const menuId = useId();
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
      .catch((err: unknown) => console.error(`[otherbench-web] failed to load unsent attachments for chat ${chat.id}:`, err));
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
  const machines = useOtherBenchStore((s) => s.machines);
  const elsewhereUnreachable = remoteUnreachable(machines, storedChat ?? chat);
  // Auto mode (spec 2026-10-03-claude-code-auto-mode-design section 2): offered
  // when any selected profile runs through Claude Code; it needs the Claude
  // login, so it's unavailable when every such profile uses an endpoint backend.
  const claudeCodeProfiles = selectedProfiles.filter((p) => isClaudeCodeProfile(p, connections));
  const showAutoToggle = claudeCodeProfiles.length > 0;
  const slashTyped = /^\/\S*$/.test(text);
  const chatCommands = useChatCommands(chat.id, claudeCodeProfiles[0]?.id ?? null, slashTyped && !menuDismissed);
  const menuRows = slashTyped && claudeCodeProfiles.length > 0 ? filterCommands(chatCommands.commands, text.slice(1)) : [];
  const menuOpen = menuRows.length > 0 && !menuDismissed;
  const activeRow = menuRows[Math.min(menuIndex, menuRows.length - 1)];
  const autoUnavailable = showAutoToggle && claudeCodeProfiles.every((p) => !!connections.find((c) => c.id === p.connectionId)?.baseUrl);
  const autoMode = (storedChat ?? chat).autoMode;
  const autoActive = autoMode && !autoUnavailable;
  const planMode = (storedChat ?? chat).planMode === true;
  const effort = (storedChat ?? chat).effort ?? null;
  const primaryProfile = profiles.find((p) => p.id === selectedProfileIds[0]) ?? null;
  const comparedProfiles = selectedProfileIds.slice(1).map((id) => profiles.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);

  const { streaming: isStreaming, stop: stopReplies } = useStopReply(chat.id);
  // While a reply runs, or messages sent during one still wait, Send makes a note (spec 2026-10-18-send-while-replying-design).
  const waitingCount = useOtherBenchStore((s) => s.chatNotes[chat.id]?.length ?? 0);
  const busy = isStreaming || waitingCount > 0;
  const noteSent = useOtherBenchStore((s) => s.noteSent);

  // A note that comes back (a stopped or lost reply, or one taken back) goes after the draft, its attachments as chips again.
  const returnedCount = useOtherBenchStore((s) => s.returnedNotes.filter((n) => n.chatId === chat.id).length);
  // Attachments a returned note brought back: a send still in flight with the same chips mustn't clear them when it ends.
  const returnedAttachmentIds = useRef(new Set<string>());
  useEffect(() => {
    if (returnedCount === 0) return;
    const taken = useOtherBenchStore.getState().takeReturnedNotes(chat.id);
    if (taken.length === 0) return;
    // While a recalled message shows, the draft is the one kept aside, not that message.
    const kept = browsing?.draft;
    setText((draft) => [kept ?? draft, ...taken.map((n) => n.text)].filter((t) => t.trim().length > 0).join('\n\n'));
    setBrowsing(null);
    for (const n of taken) for (const a of n.attachments) returnedAttachmentIds.current.add(a.attachmentId);
    setAttachments((prev) => [
      ...prev,
      ...taken.flatMap((n) => n.attachments).filter((a) => !prev.some((p) => p.id === a.attachmentId)).map((a) => ({ id: a.attachmentId, filename: a.filename, mime: a.mime })),
    ]);
    if (taken.some((n) => !n.takenBack)) setNoteReturned(true);
  }, [returnedCount, chat.id]);

  // Text handed to this chat's box from outside (an issue's "Start a chat on
  // this", spec 2026-10-20-code-tab-design Goal 7): it goes after the draft,
  // the same as a returned note, and is never sent from here.
  const hasPrefill = useOtherBenchStore((s) => s.composerPrefills[chat.id] !== undefined);
  useEffect(() => {
    if (!hasPrefill) return;
    const handed = useOtherBenchStore.getState().takeComposerPrefill(chat.id);
    if (handed === null) return;
    const kept = browsing?.draft;
    setText((draft) => [kept ?? draft, handed].filter((t) => t.trim().length > 0).join('\n\n'));
    setBrowsing(null);
    caretTo.current = 'end';
    textareaRef.current?.focus();
  }, [hasPrefill, chat.id]);

  async function handleStop(): Promise<void> {
    await stopReplies();
  }

  /** Flips the chat's Auto setting optimistically; a failed save reverts only `autoMode` and shows why. Applies at once, to a reply already running too (its Claude Code is switched). */
  async function toggleAutoMode(): Promise<void> {
    if (autoSaving) return;
    const previous = autoMode;
    const next = !previous;
    const latest = (): Chat => useOtherBenchStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    setAutoError(null);
    setAutoSaving(true);
    upsertChat({ ...latest(), autoMode: next });
    try {
      upsertChat(await api.chats.patch(chat.id, { autoMode: next }));
    } catch (err) {
      const current = useOtherBenchStore.getState().chats.find((c) => c.id === chat.id);
      // A chat removed mid-save must not be re-inserted by the revert.
      if (current) upsertChat({ ...current, autoMode: previous });
      setAutoError(err instanceof ApiError ? err.message : "Couldn't change auto mode. Please try again.");
    } finally {
      setAutoSaving(false);
    }
  }

  /** Flips the chat's Plan mode optimistically; a failed save reverts only `planMode` and shows why. Applies from the next message. */
  async function togglePlanMode(): Promise<void> {
    if (planSaving) return;
    const previous = planMode;
    const next = !previous;
    const latest = (): Chat => useOtherBenchStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    setPlanError(null);
    setPlanSaving(true);
    upsertChat({ ...latest(), planMode: next });
    try {
      upsertChat(await api.chats.patch(chat.id, { planMode: next }));
    } catch (err) {
      const current = useOtherBenchStore.getState().chats.find((c) => c.id === chat.id);
      if (current) upsertChat({ ...current, planMode: previous });
      setPlanError(err instanceof ApiError ? err.message : "Couldn't change plan mode. Please try again.");
    } finally {
      setPlanSaving(false);
    }
  }

  /**
   * Makes `profileId` the chat's profile: the selector shows it at once, and
   * the chat keeps it, so it's still chosen after switching away and back. A
   * failed save puts the chat's profile back and shows why; the selector keeps
   * the choice for this message.
   */
  async function choosePrimaryProfile(profileId: string): Promise<void> {
    setSelectedProfileIds((ids) => [profileId, ...ids.slice(1).filter((id) => id !== profileId)]);
    setPickerOpen(false);
    const latest = (): Chat => useOtherBenchStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    const previous = latest().profileId;
    if (previous === profileId) return;
    setProfileError(null);
    upsertChat({ ...latest(), profileId });
    try {
      upsertChat(await api.chats.patch(chat.id, { profileId }));
    } catch (err) {
      const current = useOtherBenchStore.getState().chats.find((c) => c.id === chat.id);
      if (current) upsertChat({ ...current, profileId: previous });
      setProfileError(err instanceof ApiError ? err.message : "Couldn't keep the profile for this chat. Please try again.");
    }
  }

  /** Sets the chat's Claude Code effort optimistically; a failed save reverts only `effort` and shows why. Applies from the next message. */
  async function changeEffort(next: ClaudeEffort | null): Promise<void> {
    if (effortSaving) return;
    const previous = effort;
    const latest = (): Chat => useOtherBenchStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    setEffortError(null);
    setEffortSaving(true);
    upsertChat({ ...latest(), effort: next });
    try {
      upsertChat(await api.chats.patch(chat.id, { effort: next }));
    } catch (err) {
      const current = useOtherBenchStore.getState().chats.find((c) => c.id === chat.id);
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
        console.error(`[otherbench-web] failed to upload attachment "${file.name}":`, err);
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
      console.error(`[otherbench-web] failed to delete attachment ${id}:`, err);
      setRemoveError(err instanceof ApiError ? err.message : 'Failed to remove the attachment. Please try again.');
    }
  }

  async function handleSend(): Promise<void> {
    const trimmed = text.trim();
    if ((trimmed.length === 0 && attachments.length === 0) || sending || selectedProfileIds.length === 0) return;
    // The same rules as the Send button, which Enter reaches without. A
    // Claude Code chat with no folder is a clean chat and may send.
    if (folderUnresolved || elsewhereUnreachable) return;
    // A message sent while a reply runs waits for it or goes into it; a command can't.
    if (busy && claudeCodeProfiles.length > 0 && isCommandText(trimmed, chatCommands.commands)) {
      setSendError(COMMAND_MID_REPLY);
      return;
    }

    setSending(true);
    // A stale remove-failure message from before this send must not linger
    // over the (possibly different) attachments actually being sent now.
    setRemoveError(null);
    setSendError(null);
    // Before the send, so a note that comes back while it's in flight keeps its notice.
    setNoteReturned(false);
    returnedAttachmentIds.current.clear();
    try {
      // The chat went quiet between the click and the server: a normal message after all.
      if (!busy || !(await sendNote(trimmed))) await sendTurn(trimmed);
      // Only what was sent: a note that came back meanwhile went after it, and stays, chips included.
      const sentIds = new Set(attachments.map((a) => a.id).filter((id) => !returnedAttachmentIds.current.has(id)));
      setText((now) => (now.startsWith(text) ? now.slice(text.length).trimStart() : now));
      setBrowsing(null);
      setAttachments((now) => now.filter((a) => !sentIds.has(a.id)));
      textareaRef.current?.focus();
    } catch (err) {
      console.error('[otherbench-web] failed to send:', err);
      // The message stays in the box to send again; say why it didn't go.
      setSendError(
        err instanceof ApiError ? (err.kind === 'command' ? err.message : `Couldn't send: ${err.message}`) : "Couldn't send the message. Please try again."
      );
    } finally {
      setSending(false);
    }
  }

  /** Sends the box as a note to the running reply; false when the server says nothing is running (send it as a turn). */
  async function sendNote(trimmed: string): Promise<boolean> {
    try {
      const note = await api.notes.send(chat.id, {
        text: trimmed,
        attachments: attachments.map((a) => ({ attachmentId: a.id })),
        parentId: parentId ?? chat.headMessageId,
        profileIds: selectedProfileIds,
        clientId: CLIENT_ID,
      });
      noteSent(note);
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.kind === 'idle') return false;
      throw err;
    }
  }

  async function sendTurn(trimmed: string): Promise<void> {
    const parts: Part[] = [
      ...(trimmed.length > 0 ? [{ type: 'text', text: trimmed } as Part] : []),
      ...attachments.map(attachmentToPart),
    ];
    // The effective tail to parent this turn on -- see ComposerProps.parentId's
    // doc for why this must NOT just be chat.headMessageId.
    const effectiveParentId = parentId ?? chat.headMessageId;
    const result = await api.turns.create(chat.id, { parentId: effectiveParentId, parts, profileIds: selectedProfileIds });

    // What the server stored and ran, not what was typed: a /clear is a context line, and a /compact runs one profile.
    registerMessage(buildUserStub(chat, result.userMessageId, effectiveParentId, result.userParts ?? parts));
    const ranProfileIds = result.profileIds ?? selectedProfileIds;
    result.assistantMessageIds.forEach((id, i) => {
      const profile = profiles.find((p) => p.id === ranProfileIds[i]);
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
    void api.turns.setHead(chat.id, result.userMessageId).catch((err: unknown) => console.error('[otherbench-web] failed to persist head:', err));
  }

  /** What picking a row puts in the box: `/clear` whole, anything else ready for its arguments. */
  const commandFill = (command: CommandRow): string => (command.name === 'clear' ? `/${command.name}` : `/${command.name} `);

  function pickCommand(command: CommandRow): void {
    caretTo.current = 'end';
    setText(commandFill(command));
    setBrowsing(null);
    setMenuDismissed(true);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (menuOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setMenuIndex((i) => (Math.min(i, menuRows.length - 1) + step + menuRows.length) % menuRows.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        // Enter on a box that already holds the row's whole command (`/clear`) sends it rather than filling it again.
        const complete = e.key === 'Enter' && activeRow !== undefined && text === commandFill(activeRow) && !text.endsWith(' ');
        if (activeRow && !complete) {
          e.preventDefault();
          pickCommand(activeRow);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
      stepHistory(e);
    }
  }

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
      caretTo.current = 'start';
      setText(recalled);
    } else {
      if (!browsing || el.value.slice(el.selectionEnd).includes('\n')) return;
      e.preventDefault();
      const index = browsing.index - 1;
      caretTo.current = 'end';
      if (index < 0) {
        setBrowsing(null);
        setText(browsing.draft);
      } else {
        setBrowsing({ ...browsing, index });
        setText(history[index] ?? '');
      }
    }
  }

  // After a step through the history, put the caret where the next step expects it.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || caretTo.current === null) return;
    const at = caretTo.current === 'start' ? 0 : el.value.length;
    el.setSelectionRange(at, at);
    caretTo.current = null;
  }, [text]);

  // Another chat (or branch) has its own history.
  useEffect(() => setBrowsing(null), [chat.id, parentId]);

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

      {autoError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {autoError}
        </div>
      )}

      {planError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {planError}
        </div>
      )}

      {profileError && (
        <div role="alert" className="mb-1.5 text-xs text-[var(--danger)]">
          {profileError}
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

      {noteReturned && (
        <p role="status" className="mb-1.5 text-xs text-[var(--text-muted)]">
          {NOTE_RETURNED}
        </p>
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

        <div className="relative">
          {menuOpen && <CommandMenu id={menuId} commands={chatCommands.commands} query={text.slice(1)} activeIndex={Math.min(menuIndex, menuRows.length - 1)} onPick={pickCommand} warning={chatCommands.warning} />}
        <textarea
          ref={textareaRef}
          // Escape here stops a running reply (Thread), unless the slash-command list takes it first.
          {...{ [ESCAPE_STOPS_REPLY_ATTR]: '' }}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setBrowsing(null); // typing in a recalled message makes it the draft
            setMenuDismissed(false);
            setMenuIndex(0);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label="Message"
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={menuOpen && activeRow ? commandOptionId(menuId, activeRow.name) : undefined}
          placeholder="Message…"
          title="Enter to send, Shift+Enter for a new line. Drag and drop or paste to attach a file."
          rows={1}
          className="block max-h-48 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2 pb-1 text-sm outline-none"
        />
        </div>

        {/*
          One line while it fits: the profile name gives way first, then the plan meter (by the box's width).
          Past that, Send and the meter drop to a line of their own rather than out of the box, and in a
          very narrow box the controls wrap too.
        */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 pb-1.5">
          <div className="flex flex-1 items-center gap-1.5 @max-xs:flex-wrap">
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
              // line-clamp with break-all, not truncate: it looks the same, but the name can shrink to a letter, so the
              // toolbar wraps by its other controls' widths rather than the full name's.
              className="max-w-full line-clamp-1 break-all rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] border-[var(--border-strong)] hover:bg-[var(--bg-sunken)]"
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
                      onClick={() => void choosePrimaryProfile(p.id)}
                      className="block w-full px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-sunken)]"
                    >
                      {p.name} <span className="text-[var(--text-muted)]">· {p.modelId}</span>
                      <span className="label-caps ml-1 text-[0.6875rem] text-[var(--text-faint)]">{isClaudeCodeProfile(p, connections) ? 'CC tools' : 'OtherBench tools'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            type="button"
            aria-label="Plan mode"
            aria-pressed={planMode}
            disabled={planSaving}
            title="Plan first: the model sets out a plan and waits for your approval before it changes anything (from the next message)"
            onClick={() => void togglePlanMode()}
            className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] disabled:opacity-50 ${
              planMode ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]' : 'border-[var(--border-strong)] text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]'
            }`}
          >
            Plan
          </button>

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
                    : 'Let Claude Code decide routine tool calls (applies at once, even to a reply that is running)'
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

          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Plan limits belong to the Claude login, so not to a Claude Code profile on an endpoint (Deck #825). */}
            {showAutoToggle && !autoUnavailable && <PlanUsageMeter busy={isStreaming} />}
            {/* While a reply runs, Send stays beside Stop: what's sent then waits for the reply or goes into it. */}
            {isStreaming && (
              <button
                type="button"
                onClick={() => void handleStop()}
                className="btn btn-danger bg-[var(--danger)] px-3 py-1 text-[var(--bg)]"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending || (text.trim().length === 0 && attachments.length === 0) || selectedProfileIds.length === 0 || folderUnresolved || elsewhereUnreachable}
              className="btn btn-primary px-3 py-1"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
