import { useEffect, useState, type ClipboardEvent, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import { api, ApiError } from '../state/api.js';
import { filesFromDataTransfer, MAX_ATTACHMENT_BYTES, UPLOAD_TOO_LARGE_MESSAGE, type ChipAttachment } from './composerAttachments.js';

export interface ComposerAttachments {
  attachments: ChipAttachment[];
  setAttachments: Dispatch<SetStateAction<ChipAttachment[]>>;
  dragOver: boolean;
  removeError: string | null;
  setRemoveError: Dispatch<SetStateAction<string | null>>;
  uploadError: string | null;
  uploadFiles: (files: File[]) => Promise<void>;
  handleDragOver: (e: DragEvent<HTMLDivElement>) => void;
  handleDragLeave: () => void;
  handleDrop: (e: DragEvent<HTMLDivElement>) => void;
  handlePaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  removeAttachment: (id: string) => Promise<void>;
}

/** The composer's attachment chips: uploads by drop, paste or the file picker, the unsent ones already on the server, and removal. */
export function useComposerAttachments(chatId: string): ComposerAttachments {
  const [attachments, setAttachments] = useState<ChipAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Attachments already on the server but not yet sent -- left by a reload,
  // or added from outside the composer (desktop `--send`) -- show as chips,
  // so they're sent with the next message rather than forgotten.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(api.attachments.list(chatId))
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        const unsent = list.filter((a) => a.messageId === null);
        if (unsent.length > 0) setAttachments((prev) => [...prev, ...unsent.filter((a) => !prev.some((p) => p.id === a.id))]);
      })
      .catch((err: unknown) => console.error(`[otherbench-web] failed to load unsent attachments for chat ${chatId}:`, err));
    return () => {
      cancelled = true;
    };
  }, [chatId]);

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
        const created = await api.attachments.upload(chatId, file);
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

  return { attachments, setAttachments, dragOver, removeError, setRemoveError, uploadError, uploadFiles, handleDragOver, handleDragLeave, handleDrop, handlePaste, removeAttachment };
}
