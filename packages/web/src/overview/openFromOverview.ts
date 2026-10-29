import { NARROW_BREAKPOINT } from '../lib/useMediaQuery.js';
import { appTabId } from '../state/appTab.js';
import { sentElsewhere, useOtherBenchStore, type IssueState } from '../state/store.js';

/**
 * Where a click in the Overview goes. Each closes the Overview (the store's
 * navigation actions do) and, for an app, an issue or a card, brings the Code panel into
 * view on it, as `code/openDeckCard.ts` does: expanded if collapsed, or the
 * overlay on a narrow window. When Code mode (or, for a chat, its mode) is in
 * another window, the click goes to that window instead (desktop/windows.ts),
 * which opens it the same way.
 */
export function openChat(chatId: string): void {
  useOtherBenchStore.getState().setActiveChatId(chatId);
}

export function openApp(appId: string): void {
  if (sentElsewhere('code', { kind: 'app', appId })) return;
  const state = useOtherBenchStore.getState();
  state.openAppHome(appId);
  state.setCodePanelTab('issues');
  showPanel();
}

function showPanel(): void {
  const state = useOtherBenchStore.getState();
  const narrow = typeof window.matchMedia === 'function' && window.matchMedia(NARROW_BREAKPOINT).matches;
  if (narrow) state.setInspectorOverlayOpen(true);
  else if (state.inspectorCollapsed) state.setInspectorCollapsed(false);
}

export function openIssue(appId: string, n: number, state: IssueState): void {
  if (sentElsewhere('code', { kind: 'issue', appId, n, state })) return;
  const store = useOtherBenchStore.getState();
  store.openAppHome(appId);
  store.setCodePanelTab('issues');
  store.setIssueView(appTabId(appId), { state, selected: n });
  showPanel();
}

export function openCard(appId: string, cardId: number): void {
  if (sentElsewhere('code', { kind: 'card', appId, cardId })) return;
  const store = useOtherBenchStore.getState();
  store.openAppHome(appId);
  store.setCodePanelTab('deck');
  store.setDeckView(appTabId(appId), { selected: cardId });
  showPanel();
}
