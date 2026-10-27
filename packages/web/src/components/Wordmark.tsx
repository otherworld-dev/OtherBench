import type { JSX } from 'react';

/**
 * "OtherBench" set the Other family way (brand sheet v1): "Other" light, the
 * suffix bold in the brand teal, one word. Not in caps, so it never takes
 * `label-caps`. The icon sits beside it when `icon` is set.
 */
export function Wordmark({ className = '', icon = true }: { className?: string; icon?: boolean }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-2.5 font-sans tracking-[-0.01em] ${className}`}>
      {icon && <img src="/favicon.svg" alt="" aria-hidden="true" className="h-[1.6em] w-[1.6em]" />}
      <span>
        <span className="font-light">Other</span>
        <span className="font-bold text-[var(--brand)]">Bench</span>
      </span>
    </span>
  );
}
