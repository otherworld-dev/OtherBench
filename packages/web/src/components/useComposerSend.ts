import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { Part } from '@otherbench/core/types/messages.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { isCommandText, type CommandRow } from '@otherbench/core/domain/context-lines.js';
import { COMMAND_MID_REPLY } from '@otherbench/core/domain/notes.js';
import { CLIENT_ID } from '../lib/clientId.js';
import { api, ApiError } from '../state/api.js';
import { buildAssistantStub, buildUserStub } from '../state/stubs.js';
import { useOtherBenchStore } from '../state/store.js';
import { useAppNotesStore } from '../state/appNotes.js';
import { attachmentToPart, type ChipAttachment } from './composerAttachments.js';
import type { HistoryBrowsing } from './useComposerHistory.js';

export interface ComposerSendInput {
  chat: Chat;
  /** See ComposerProps.parentId. */
  parentId: string | null | undefined;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  setBrowsing: Dispatch<SetStateAction<HistoryBrowsing | null>>;
  attachments: ChipAttachment[];
  setAttachments: Dispatch<SetStateAction<ChipAttachment[]>>;
  setRemoveError: Dispatch<SetStateAction<string | null>>;
  setNoteReturned: Dispatch<SetStateAction<boolean>>;
  /** Attachments a returned note brought back, which a send in flight mustn't clear. */
  returnedAttachmentIds: RefObject<Set<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** A one-line `# fact` in an app chat, saved to the app's notes rather than sent. */
  noteFact: string | null;
  selectedProfileIds: string[];
  profiles: Profile[];
  folderUnresolved: boolean;
  elsewhereUnreachable: boolean;
  /** A reply runs, or notes sent during one still wait. */
  busy: boolean;
  claudeCodeProfiles: Profile[];
  commands: CommandRow[];
}

export interface ComposerSend {
  sending: boolean;
  sendError: string | null;
  handleSend: () => Promise<void>;
}

/** Sending the box: as a turn, as a note to a running reply, or (a `# fact` in an app chat) to the app's notes. */
export function useComposerSend({
  chat,
  parentId,
  text,
  setText,
  setBrowsing,
  attachments,
  setAttachments,
  setRemoveError,
  setNoteReturned,
  returnedAttachmentIds,
  textareaRef,
  noteFact,
  selectedProfileIds,
  profiles,
  folderUnresolved,
  elsewhereUnreachable,
  busy,
  claudeCodeProfiles,
  commands,
}: ComposerSendInput): ComposerSend {
  const registerMessage = useOtherBenchStore((s) => s.registerMessage);
  const setHeadMessageId = useOtherBenchStore((s) => s.setHeadMessageId);
  const noteSent = useOtherBenchStore((s) => s.noteSent);
  const setAppNotesView = useAppNotesStore((s) => s.setView);
  const addFactCard = useAppNotesStore((s) => s.addCard);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  async function handleSend(): Promise<void> {
    const trimmed = text.trim();
    // In an app chat, a one-line `# fact` goes to the app's notes, never to the model (spec 2026-11-05-app-notes-design).
    if (noteFact !== null && !sending) {
      await saveNoteFact(noteFact);
      return;
    }
    if ((trimmed.length === 0 && attachments.length === 0) || sending || selectedProfileIds.length === 0) return;
    // The same rules as the Send button, which Enter reaches without. A
    // Claude Code chat with no folder is a clean chat and may send.
    if (folderUnresolved || elsewhereUnreachable) return;
    // A message sent while a reply runs waits for it or goes into it; a command can't.
    if (busy && claudeCodeProfiles.length > 0 && isCommandText(trimmed, commands)) {
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
      if (!busy || !(await sendNote(trimmed))) await sendTurnOrNote(trimmed);
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

  /** Files `fact` in the app's notes and shows its card in this chat; the box empties once it's saved. */
  async function saveNoteFact(fact: string): Promise<void> {
    if (!chat.appId) return;
    const appId = chat.appId;
    setSending(true);
    setSendError(null);
    try {
      const saved = await api.appNotes.addFact(appId, { text: fact, chatId: chat.id });
      setAppNotesView(appId, saved);
      // eslint-disable-next-line react-hooks/purity -- runs after the save resolves, never in render; the compiler can't tell, through the textarea's onKeyDown, that handleSend only runs from an event.
      addFactCard(chat.id, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, appId, fact: saved.fact, state: 'saved' });
      setText('');
      textareaRef.current?.focus();
    } catch (err) {
      setSendError(`Couldn't save it to the notes: ${err instanceof ApiError ? err.message : 'please try again.'}`);
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

  /** Sends the box as a turn, or as a note when notes this box hadn't heard of are waiting (another tab's, or a reply just started). */
  async function sendTurnOrNote(trimmed: string): Promise<void> {
    try {
      await sendTurn(trimmed);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409 && err.kind === 'notes-waiting') || !(await sendNote(trimmed))) throw err;
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

  return { sending, sendError, handleSend };
}
