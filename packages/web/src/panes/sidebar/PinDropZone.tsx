import type { JSX } from 'react';
import { PinIcon } from '../../components/icons.js';
import { CHAT_DRAG_MIME } from './ChatRow.js';

export interface PinDropZoneProps {
  /** A chat is dragged over it. */
  active: boolean;
  onActiveChange: (active: boolean) => void;
  /** A drop landed here, a chat or not: the drag is over. */
  onDragFinished: () => void;
  /** Pins the dropped chat. */
  onPin: (chatId: string) => void;
}

/**
 * "Drop here to pin": while a chat is dragged with nothing pinned yet, it takes the search box's place. Not a new
 * section in the list, which would push every row down under the pointer mid-drag.
 */
export function PinDropZone({ active, onActiveChange, onDragFinished, onPin }: PinDropZoneProps): JSX.Element {
  return (
    <div
      data-testid="pinned-drop-zone"
      data-drop-active={active ? 'true' : undefined}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes(CHAT_DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!active) onActiveChange(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        onActiveChange(false);
      }}
      onDrop={(e) => {
        const chatId = e.dataTransfer.getData(CHAT_DRAG_MIME);
        onActiveChange(false);
        onDragFinished();
        if (!chatId) return;
        e.preventDefault();
        onPin(chatId);
      }}
      // Same box as the search field it stands in for, so nothing below it moves.
      className={`flex w-full items-center gap-1.5 rounded-sm border border-dashed px-2 py-1.5 text-sm text-[var(--text-muted)] ${
        active ? 'border-[var(--accent)] bg-[var(--bg-sunken)] text-[var(--text)]' : 'border-[var(--border-strong)] bg-[var(--bg)]'
      }`}
    >
      <PinIcon />
      Drop here to pin
    </div>
  );
}
