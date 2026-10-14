import { afterEach, describe, expect, it } from 'vitest';
import { classifyTarget, GRUNT_UI_TITLE, showsGruntUi } from '@grunt/core/domain/computer-apps.js';
import indexHtml from '../../index.html?raw';
import { keepGruntTitle, markedTitle } from './gruntTitle.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the marker in Grunt's page title", () => {
  let stop: () => void = () => undefined;
  afterEach(() => stop());

  it('is in index.html, so it is there before any script runs', () => {
    expect(indexHtml).toContain(`<title>${GRUNT_UI_TITLE}</title>`);
  });

  it('is set on load and put back whenever the title is changed or replaced', async () => {
    document.title = 'Grunt';
    stop = keepGruntTitle();
    expect(document.title).toBe(GRUNT_UI_TITLE);
    document.title = 'Chat about invoices';
    await settle();
    expect(document.title).toBe('Chat about invoices [grunt-ui]');
    // A view that swaps the <title> element for another.
    document.head.querySelector('title')?.remove();
    const other = document.createElement('title');
    other.textContent = 'Settings';
    document.head.appendChild(other);
    await settle();
    expect(showsGruntUi(document.title)).toBe(true);
    // Moving around the app (history entries) leaves it in place.
    history.pushState({}, '', '/chats/abc');
    history.pushState({}, '', '/settings');
    await settle();
    expect(showsGruntUi(document.title)).toBe(true);
  });

  it("makes a browser window showing it one computer use refuses", () => {
    document.title = 'Grunt';
    stop = keepGruntTitle();
    const classified = classifyTarget({
      path: 'C:\Program Files\Google\Chrome\Application\chrome.exe',
      originalName: 'chrome.exe',
      signer: 'Google LLC',
      console: false,
      location: 'fixed',
      elevated: false,
      uiAccess: false,
      grunt: false,
      shellView: false,
      title: `${document.title} - Google Chrome`,
      windowId: 'hwnd-1',
      pid: 4242,
      startedAt: 't0',
    });
    expect(classified.kind).toBe('refuse');
  });

  it('adds the marker only once, and gives an empty title the whole one', () => {
    expect(markedTitle(GRUNT_UI_TITLE)).toBe(GRUNT_UI_TITLE);
    expect(markedTitle('')).toBe(GRUNT_UI_TITLE);
    expect(markedTitle('  ')).toBe(GRUNT_UI_TITLE);
    expect(markedTitle('Docs')).toBe('Docs [grunt-ui]');
    expect(markedTitle(markedTitle('Docs'))).toBe('Docs [grunt-ui]');
  });
});
