import { OTHERBENCH_UI_TITLE, OTHERBENCH_UI_TITLE_MARKER, showsOtherBenchUi } from '@otherbench/core/domain/computer-apps.js';

/**
 * Every page of OtherBench's UI carries `OTHERBENCH_UI_TITLE_MARKER` in its title, so
 * computer use refuses a browser window that is showing OtherBench (core's
 * `classifyTarget`, and the desktop shell before every step). Without it a
 * model with a lasting grant for a browser could open OtherBench there and answer
 * its own approval cards.
 */
export function markedTitle(title: string): string {
  if (showsOtherBenchUi(title)) return title;
  return title.trim() === '' ? OTHERBENCH_UI_TITLE : `${title} ${OTHERBENCH_UI_TITLE_MARKER}`;
}

/**
 * Puts the marker in `doc.title` now and puts it back whenever anything
 * changes the title later (a page, a view, a library). index.html starts
 * with it already, so it is there before any script runs. Returns a stop
 * function, for tests.
 */
export function keepOtherBenchTitle(doc: Document = document): () => void {
  const apply = (): void => {
    const next = markedTitle(doc.title);
    if (doc.title !== next) doc.title = next;
  };
  apply();
  const observer = new MutationObserver(apply);
  observer.observe(doc.head, { subtree: true, childList: true, characterData: true });
  return () => observer.disconnect();
}
