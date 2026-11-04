import { useEffect, type JSX, type RefObject } from 'react';

/** "3 of 12", "No matches", or, with none picked yet, how many there are. Nothing before anything is typed. */
export function findStatus(query: string, current: number, total: number): string {
  if (query.length === 0) return '';
  if (total === 0) return 'No matches';
  if (current < 0) return `${total} ${total === 1 ? 'match' : 'matches'}`;
  return `${current + 1} of ${total}`;
}

export interface FindBarProps {
  query: string;
  /** The match shown, from 0; -1 for none. */
  current: number;
  total: number;
  onQueryChange: (query: string) => void;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
  /** The text box, so Ctrl+F again can put the focus back in it. */
  inputRef: RefObject<HTMLInputElement | null>;
}

/** The find bar over a chat's thread (Ctrl+F): what to find, how many there are, next, previous and close. */
export function FindBar({ query, current, total, onQueryChange, onStep, onClose, inputRef }: FindBarProps): JSX.Element {
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [inputRef]);
  const status = findStatus(query, current, total);
  const icon = 'rounded px-1.5 py-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div
      role="search"
      aria-label="Find in this chat"
      className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-[3px] border border-[var(--border)] bg-[var(--bg-raised)] py-1 pr-1 pl-2 text-xs shadow"
    >
      <input
        ref={inputRef}
        type="text"
        aria-label="Find in this chat"
        placeholder="Find in this chat"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            if (total > 0) onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            // Taken here, so Escape in the find bar never stops the chat's reply.
            e.preventDefault();
            onClose();
          }
        }}
        className="w-44 bg-transparent text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
      />
      <span role="status" aria-label="Matches" className="min-w-[4.5rem] text-right text-[var(--text-muted)] tabular-nums">
        {status}
      </span>
      <button type="button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={total === 0} onClick={() => onStep(-1)} className={icon}>
        <span aria-hidden="true">↑</span>
      </button>
      <button type="button" aria-label="Next match" title="Next match (Enter)" disabled={total === 0} onClick={() => onStep(1)} className={icon}>
        <span aria-hidden="true">↓</span>
      </button>
      <button type="button" aria-label="Close find" title="Close (Esc)" onClick={onClose} className={icon}>
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
