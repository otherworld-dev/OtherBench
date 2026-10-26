import { NARROW_BREAKPOINT } from '../lib/useMediaQuery.js';
import { appTabId } from '../state/appTab.js';
import { useOtherBenchStore, type IssueState } from '../state/store.js';

/**
 * Where a click in the Overview goes. Each closes the Overview (the store's
 * navigation actions do) and, for an issue or card, brings the Code panel into
 * view on it, as `code/openDeckCard.ts` does: expanded if collapsed, or the
 * overlay on a narrow window.
 */
export function openChat(chatId: string): void {
  useOtherBenchStore.getState().setActiveChatId(chatId);
}

export function openApp(appId: string): void {
  const state = useOtherBenchStore.getState();
  state.openAppHome(appId);
  state.setCodePanelTab('issues');
}

function showPanel(): void {
  const state = useOtherBenchStore.getState();
  const narrow = typeof window.matchMedia === 'function' && window.matchMedia(NARROW_BREAKPOINT).matches;
  if (narrow) state.setInspectorOverlayOpen(true);
  else if (state.inspectorCollapsed) state.setInspectorCollapsed(false);
}

export function openIssue(appId: string, n: number, state: IssueState): void {
  const store = useOtherBenchStore.getState();
  store.openAppHome(appId);
  store.setCodePanelTab('issues');
  store.setIssueView(appTabId(appId), { state, selected: n });
  showPanel();
}

export function openCard(appId: string, cardId: number): void {
  const store = useOtherBenchStore.getState();
  store.openAppHome(appId);
  store.setCodePanelTab('deck');
  store.setDeckView(appTabId(appId), { selected: cardId });
  showPanel();
}
