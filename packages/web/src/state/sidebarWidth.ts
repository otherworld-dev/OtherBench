import { panelWidth } from './panelWidth.js';

/** localStorage key: the sidebar's width in rem, so it follows the text size. Per device. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'otherbench.sidebarWidth';
export const SIDEBAR_WIDTH_DEFAULT = 16.25;
export const SIDEBAR_WIDTH_MIN = 12.5;
export const SIDEBAR_WIDTH_MAX = 30;
/** The sidebar never takes more than this share of the window (App's grid column), whatever was saved. */
export const SIDEBAR_WIDTH_MAX_SHARE = 0.4;

/** The sidebar's width, handed to the layout as `--sidebar-w`. */
export const sidebarWidth = panelWidth({
  key: SIDEBAR_WIDTH_STORAGE_KEY,
  cssVar: '--sidebar-w',
  defaultRem: SIDEBAR_WIDTH_DEFAULT,
  min: SIDEBAR_WIDTH_MIN,
  max: SIDEBAR_WIDTH_MAX,
  maxShare: SIDEBAR_WIDTH_MAX_SHARE,
});

/** `rem` clamped to the allowed range; anything that isn't a finite number is the default. */
export const clampSidebarWidth = (rem: number): number => sidebarWidth.clamp(rem);
/** Applies the saved width; call once before first render. */
export const initSidebarWidth = (): void => sidebarWidth.init();
/** The sidebar's width in rem right now. */
export const getSidebarWidth = (): number => sidebarWidth.get();
/** Sets the width (clamped). `save: false` is for live dragging; the drag's end saves. */
export const setSidebarWidth = (rem: number, save = true): void => sidebarWidth.set(rem, save);
/** The sidebar's width in rem; re-renders when it changes. */
export const useSidebarWidth = (): number => sidebarWidth.use();
/** Test hook: forget the cached width so the next read goes back to storage. */
export const resetSidebarWidthForTests = (): void => sidebarWidth.resetForTests();
