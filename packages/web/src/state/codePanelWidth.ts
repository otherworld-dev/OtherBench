import { panelWidth } from './panelWidth.js';
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX_SHARE, sidebarWidth } from './sidebarWidth.js';

/** localStorage key: Code mode's right panel width in rem (spec 2026-10-21-code-terminal-design). Per device. */
export const CODE_PANEL_WIDTH_STORAGE_KEY = 'otherbench.codePanelWidth';
const CODE_PANEL_WIDTH_DEFAULT = 24;
const CODE_PANEL_MAX_SHARE = 0.7;

/** The chat panes keep at least this much of the window, in rem, however wide the Code panel and the sidebar are. */
export const CHAT_AREA_MIN_REM = 20;

/**
 * Code mode's right panel (Issues, Files, Chat, Terminal): 24rem to start, 18rem at least, at most 70% of the
 * window, and never so wide that the sidebar and it leave the chat panes less than CHAT_AREA_MIN_REM.
 */
export const codePanelWidth = panelWidth({
  key: CODE_PANEL_WIDTH_STORAGE_KEY,
  cssVar: '--code-panel-w',
  defaultRem: CODE_PANEL_WIDTH_DEFAULT,
  min: 18,
  max: 120,
  maxShare: CODE_PANEL_MAX_SHARE,
  // The sidebar as App's grid shows it (its own share cap applied), plus the chat area's minimum.
  reservePx: (remPx) => Math.min(sidebarWidth.get() * remPx, SIDEBAR_WIDTH_MAX_SHARE * window.innerWidth) + CHAT_AREA_MIN_REM * remPx,
});

const vw = (share: number): string => `${Math.round(share * 100)}vw`;

/**
 * The Code panel column's CSS width: the same cap as `codePanelWidth.shownMax`, in CSS so a window resize or a
 * sidebar drag applies it at once. The saved width is kept, and comes back when there's room again.
 */
export const CODE_PANEL_CSS_WIDTH =
  `min(var(--code-panel-w, ${CODE_PANEL_WIDTH_DEFAULT}rem), ${vw(CODE_PANEL_MAX_SHARE)}, ` +
  `calc(100vw - min(var(--sidebar-w, ${SIDEBAR_WIDTH_DEFAULT}rem), ${vw(SIDEBAR_WIDTH_MAX_SHARE)}) - ${CHAT_AREA_MIN_REM}rem))`;
