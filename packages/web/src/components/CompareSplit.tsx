import type { JSX } from 'react';
import { VariantGrid, type VariantTabsProps } from './VariantTabs.js';

export type CompareSplitProps = Omit<VariantTabsProps, 'onClose'>;

/**
 * The `⇹ Split` two-up view: every variant rendered side by side instead of
 * behind tabs, for reading answers against each other. Task 27's design
 * calls for this to reuse the same variant renderer as the tab strip -- "a
 * container swap, not a second implementation" -- so this is a thin wrapper
 * around `VariantGrid` (VariantTabs.tsx), which is the exact same grid
 * `VariantTabs` renders inline when its own Split toggle is on. A standalone
 * component exists (rather than inlining `VariantGrid` everywhere) because
 * task 27's brief calls it out as its own file/seam.
 */
export function CompareSplit(props: CompareSplitProps): JSX.Element {
  return <VariantGrid {...props} />;
}
