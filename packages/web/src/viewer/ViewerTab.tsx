import type { JSX } from 'react';
import { ItemView } from './ItemView.js';
import { itemName, parseViewTab } from './items.js';
import { ViewerContext, viewerActionsFor } from './ViewerContext.js';

/** A viewer item popped out into its own pane-grid tab (spec 2026-10-07-viewer). */
export function ViewerTab({ tabId }: { tabId: string }): JSX.Element {
  const view = parseViewTab(tabId);
  if (!view) return <p className="p-4 text-sm text-[var(--text-faint)]">This tab can't be shown.</p>;
  // Its chat's actions, so links and paths in a viewed file open as they would in the chat's panel, never navigating the app away.
  return (
    <ViewerContext.Provider value={viewerActionsFor(view.chatId)}>
      <section aria-label={itemName(view.item)} className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        <ItemView chatId={view.chatId} item={view.item} />
      </section>
    </ViewerContext.Provider>
  );
}
