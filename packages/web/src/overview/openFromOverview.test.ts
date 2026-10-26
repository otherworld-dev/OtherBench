import { beforeEach, describe, expect, it } from 'vitest';
import { appTabId } from '../state/appTab.js';
import { useOtherBenchStore } from '../state/store.js';
import { openApp, openCard, openChat, openIssue } from './openFromOverview.js';

const s = () => useOtherBenchStore.getState();

describe('openFromOverview', () => {
  beforeEach(() => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    window.localStorage.clear();
    s().setOverviewOpen(true);
  });

  it('openChat shows the chat and closes the overview', () => {
    openChat('c1');
    expect(s().activeChatId).toBe('c1');
    expect(s().overviewOpen).toBe(false);
  });

  it('openApp opens the app home on the Issues tab', () => {
    openApp('a1');
    expect(s().mode).toBe('code');
    expect(s().activeChatId).toBe(appTabId('a1'));
    expect(s().codePanelTab).toBe('issues');
    expect(s().overviewOpen).toBe(false);
  });

  it('openIssue selects the issue in the app home Issues view and uncollapses the panel', () => {
    s().setInspectorCollapsed(true);
    openIssue('a1', 7, 'closed');
    expect(s().codePanelTab).toBe('issues');
    expect(s().issueViews[appTabId('a1')]).toMatchObject({ state: 'closed', selected: 7 });
    expect(s().inspectorCollapsed).toBe(false);
    expect(s().overviewOpen).toBe(false);
  });

  it('openCard selects the card in the app home Deck view', () => {
    openCard('a1', 42);
    expect(s().codePanelTab).toBe('deck');
    expect(s().deckViews[appTabId('a1')]).toMatchObject({ selected: 42 });
    expect(s().overviewOpen).toBe(false);
  });

  it('opens the overlay instead on a narrow window', () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      openIssue('a1', 1, 'open');
      expect(s().inspectorOverlayOpen).toBe(true);
    } finally {
      window.matchMedia = original;
    }
  });
});
