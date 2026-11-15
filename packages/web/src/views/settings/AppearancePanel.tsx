import type { JSX } from 'react';
import { useOneProjectOpen } from '../../state/oneProjectOpen.js';
import { TEXT_SIZE_STEPS, useTextSize } from '../../state/textSize.js';

/** Display preferences. Text size is also reachable with Ctrl/Cmd + `=`, `-` and `0`. */
export function AppearancePanel(): JSX.Element {
  const [size, setSize] = useTextSize();
  const [oneProjectOpen, setOneProjectOpen] = useOneProjectOpen();

  return (
    <section className="max-w-xl space-y-4 text-sm">
      <h3 className="text-sm font-semibold">Appearance</h3>
      <label className="flex items-center gap-2">
        Text size
        <select
          aria-label="Text size"
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1"
        >
          {TEXT_SIZE_STEPS.map((pct) => (
            <option key={pct} value={pct}>
              {pct}%
            </option>
          ))}
        </select>
      </label>
      <p className="text-[var(--text-muted)]">Shortcuts: Ctrl/Cmd + = to enlarge, Ctrl/Cmd + - to shrink, Ctrl/Cmd + 0 to reset.</p>
      <div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={oneProjectOpen} onChange={(e) => setOneProjectOpen(e.target.checked)} />
          One project open at a time
        </label>
        <p className="mt-1 text-[var(--text-muted)]">
          Opening a project in the chat list folds the others, so only one parent project's chats show. Its sub-projects open with it.
        </p>
      </div>
    </section>
  );
}
