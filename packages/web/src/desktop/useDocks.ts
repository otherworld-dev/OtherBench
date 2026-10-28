import { useEffect } from 'react';
import { openApp, openCard, openIssue } from '../overview/openFromOverview.js';
import { useOtherBenchStore } from '../state/store.js';
import { isDesktop, onDesktopEvent, undockedViews } from './bridge.js';
import { parseOpenRequest, parseUndocked, saveUndocked, type OpenRequest } from './windows.js';

/** Opens what another window handed over, here: the window it was sent to holds it. */
export function applyOpenRequest(request: OpenRequest): void {
  const state = useOtherBenchStore.getState();
  switch (request.kind) {
    case 'chat':
      state.setActiveChatId(request.chatId);
      return;
    case 'tab':
      state.openTab(request.chatId);
      return;
    case 'home':
      state.openAppHome(request.appId);
      return;
    case 'app':
      openApp(request.appId);
      return;
    case 'issue':
      openIssue(request.appId, request.n, request.state);
      return;
    case 'card':
      openCard(request.appId, request.cardId);
      return;
  }
}

function applyUndocked(value: unknown): void {
  const views = parseUndocked(value);
  saveUndocked(views);
  useOtherBenchStore.getState().setUndocked(views);
}

/**
 * Every app window's side of undocking (desktop/windows.ts): keeps the store's
 * undocked list as the shell has it, asking once on start (the saved copy may
 * be stale) and then following `docks-changed`, and opens what another window
 * hands over (`open-request`). Desktop only.
 */
export function useDocks(): void {
  useEffect(() => {
    if (!isDesktop()) return;
    let disposed = false;
    const offs: (() => void)[] = [];
    const keep = (off: () => void): void => {
      if (disposed) off();
      else offs.push(off);
    };
    void onDesktopEvent('docks-changed', applyUndocked).then(keep);
    void onDesktopEvent('open-request', (payload) => {
      const request = parseOpenRequest(payload);
      if (request) applyOpenRequest(request);
    }).then(keep);
    undockedViews()
      .then((value) => {
        if (!disposed) applyUndocked(value);
      })
      .catch((err: unknown) => console.error('[otherbench-web] failed to ask which windows are undocked:', err));
    return () => {
      disposed = true;
      for (const off of offs) off();
    };
  }, []);
}
