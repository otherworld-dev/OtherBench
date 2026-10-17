import type { JSX } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import { workingElsewhere } from '../state/machines.js';
import { useOtherBenchStore } from '../state/store.js';

/**
 * Says a paired machine is writing a reply in this chat. A reply still being
 * written isn't synced, so until it is shown here (or arrives once it
 * finishes) this is the only sign of it. Hidden once a reply in this chat is
 * streaming on screen.
 */
export function ElsewhereWorking({ chat }: { chat: Pick<Chat, 'id'> }): JSX.Element | null {
  const name = useOtherBenchStore((s) => workingElsewhere(s.machines, chat.id));
  const streamingHere = useOtherBenchStore((s) => Object.values(s.messages).some((m) => m.chatId === chat.id && m.status === 'streaming'));
  if (!name || streamingHere) return null;
  return (
    <div data-testid="elsewhere-working" role="status" className="mx-4 mb-2 flex items-center gap-2 text-xs text-[var(--text-muted)]">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]" aria-hidden="true" />
      Replying on {name}… it shows here when it&apos;s done.
    </div>
  );
}
