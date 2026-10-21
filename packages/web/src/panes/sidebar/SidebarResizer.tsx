import type { JSX } from 'react';
import { sidebarWidth } from '../../state/sidebarWidth.js';
import { PanelResizer } from '../PanelResizer.js';

/** The sidebar's right edge: drag it, or focus it and use Left/Right, to change the sidebar's width; double-click puts it back. */
export function SidebarResizer(): JSX.Element {
  return <PanelResizer width={sidebarWidth} edge="right" label="Resize sidebar" />;
}
