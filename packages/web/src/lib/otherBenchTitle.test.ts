import { afterEach, describe, expect, it } from 'vitest';
import { classifyTarget, COMPUTER_OTHERBENCH_UI_REASON, OTHERBENCH_UI_TITLE, showsOtherBenchUi } from '@otherbench/core/domain/computer-apps.js';
import indexHtml from '../../index.html?raw';
import { keepOtherBenchTitle, markedTitle } from './otherBenchTitle.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the marker in OtherBench's page title", () => {
  let stop: () => void = () => undefined;
  afterEach(() => stop());

  it('is in index.html, so it is there before any script runs', () => {
    expect(indexHtml).toContain(`<title>${OTHERBENCH_UI_TITLE}</title>`);
  });

  it('is set on load and put back whenever the title is changed or replaced', async () => {
    document.title = 'OtherBench';
    stop = keepOtherBenchTitle();
    expect(document.title).toBe(OTHERBENCH_UI_TITLE);
    document.title = 'Chat about invoices';
    await settle();
    expect(document.title).toBe('Chat about invoices [otherbench-ui]');
    // A view that swaps the <title> element for another.
    document.head.querySelector('title')?.remove();
    const other = document.createElement('title');
    other.textContent = 'Settings';
    document.head.appendChild(other);
    await settle();
    expect(showsOtherBenchUi(document.title)).toBe(true);
    // Moving around the app (history entries) leaves it in place.
    history.pushState({}, '', '/chats/abc');
    history.pushState({}, '', '/settings');
    await settle();
    expect(showsOtherBenchUi(document.title)).toBe(true);
  });

  it("makes a browser window showing it one computer use refuses", () => {
    document.title = 'OtherBench';
    stop = keepOtherBenchTitle();
    const facts = (title: string) => ({
      path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      originalName: 'chrome.exe',
      signer: 'Google LLC',
      console: false,
      location: 'fixed',
      elevated: false,
      uiAccess: false,
      otherbench: false,
      shellView: false,
      title,
      windowId: 'hwnd-1',
      pid: 4242,
      startedAt: 't0',
    });
    expect(classifyTarget(facts(`${document.title} - Google Chrome`))).toEqual({ kind: 'refuse', reason: COMPUTER_OTHERBENCH_UI_REASON });
    // The same browser on any other page is an app like any other.
    expect(classifyTarget(facts('Inbox - Google Chrome')).kind).toBe('app');
  });

  it('adds the marker only once, and gives an empty title the whole one', () => {
    expect(markedTitle(OTHERBENCH_UI_TITLE)).toBe(OTHERBENCH_UI_TITLE);
    expect(markedTitle('')).toBe(OTHERBENCH_UI_TITLE);
    expect(markedTitle('  ')).toBe(OTHERBENCH_UI_TITLE);
    expect(markedTitle('Docs')).toBe('Docs [otherbench-ui]');
    expect(markedTitle(markedTitle('Docs'))).toBe('Docs [otherbench-ui]');
  });
});
