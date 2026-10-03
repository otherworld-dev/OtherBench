import { useRef, useState, type JSX } from 'react';

export interface InlineNameInputProps {
  /** The current name. The field starts with it; later changes are ignored so typing is never overwritten. */
  initial: string;
  /** Accessible name of the field. */
  label: string;
  maxLength?: number;
  /** Called once with the trimmed, non-empty, changed text. */
  onCommit: (value: string) => void;
  /** Called once on Esc, on Enter or blur with the text unchanged, or on blur with the field empty. */
  onCancel: () => void;
}

/**
 * In-place name editing (spec §3 Rename): Enter saves, Esc cancels, an empty
 * name is refused (the field stays, marked invalid), and leaving the field
 * saves a valid change. Settles exactly once, so Enter followed by the blur
 * that unmounting causes can't save twice.
 */
export function InlineNameInput({ initial, label, maxLength, onCommit, onCancel }: InlineNameInputProps): JSX.Element {
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const settled = useRef(false);

  function commit(): void {
    if (settled.current) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setInvalid(true);
      return;
    }
    settled.current = true;
    if (trimmed === initial.trim()) onCancel();
    else onCommit(trimmed);
  }

  function cancel(): void {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  }

  return (
    <input
      autoFocus
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={value}
      maxLength={maxLength}
      onChange={(e) => {
        setValue(e.target.value);
        setInvalid(false);
      }}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      }}
      onBlur={() => (value.trim().length === 0 ? cancel() : commit())}
      className={`w-full min-w-0 rounded border bg-[var(--bg)] px-2 py-1 text-sm outline-none ${
        invalid ? 'border-[var(--danger)]' : 'border-[var(--accent)]'
      }`}
    />
  );
}
