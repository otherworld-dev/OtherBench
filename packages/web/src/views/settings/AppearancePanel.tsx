import type { JSX } from 'react';
import { TEXT_SIZE_STEPS, useTextSize } from '../../state/textSize.js';

/** Display preferences. Text size is also reachable with Ctrl/Cmd + `=`, `-` and `0`. */
export function AppearancePanel(): JSX.Element {
  const [size, setSize] = useTextSize();

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
    </section>
  );
}
