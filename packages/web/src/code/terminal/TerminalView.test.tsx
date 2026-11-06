import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalInfo } from '@otherbench/core/types/terminal.js';

// xterm needs a real canvas and layout; a stand-in records what TerminalView hands it.
const xterm = vi.hoisted(() => ({
  instances: [] as Array<{ options: Record<string, unknown>; disposed: boolean }>,
  webLinkHandlers: [] as Array<(event: MouseEvent, uri: string) => void>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    disposed = false;
    cols = 80;
    rows = 24;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterm.instances.push(this);
    }
    loadAddon(): void {}
    attachCustomKeyEventHandler(): void {}
    onData(): { dispose(): void } {
      return { dispose() {} };
    }
    open(): void {}
    focus(): void {}
    reset(): void {}
    write(): void {}
    getSelection(): string {
      return '';
    }
    hasSelection(): boolean {
      return false;
    }
    clearSelection(): void {}
    dispose(): void {
      this.disposed = true;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) {
      xterm.webLinkHandlers.push(handler);
    }
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('./feed.js', () => ({ openTerminalFeed: () => ({ mode: 'poll', close() {} }) }));
vi.mock('../../desktop/bridge.js', () => ({ openInBrowser: vi.fn(async () => undefined) }));

import { openInBrowser } from '../../desktop/bridge.js';
import { TerminalView } from './TerminalView.js';

const terminal: TerminalInfo = { id: 't1', appId: 'a1', name: 'pwsh', shellId: 'pwsh', exitCode: null, createdAt: 1 };

type Listener = (e: { matches: boolean }) => void;
let schemeListeners: Set<Listener>;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  xterm.instances.length = 0;
  xterm.webLinkHandlers.length = 0;
  vi.mocked(openInBrowser).mockClear();
  schemeListeners = new Set();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: (_type: string, l: Listener) => schemeListeners.add(l),
    removeEventListener: (_type: string, l: Listener) => schemeListeners.delete(l),
  }));
  document.documentElement.style.setProperty('--bg', '#f2efe6');
  document.documentElement.style.setProperty('--text', '#0a1118');
});
afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  document.documentElement.style.removeProperty('--bg');
  document.documentElement.style.removeProperty('--text');
});

const view = () => render(<TerminalView appId="a1" terminal={terminal} focusToken={0} />);
const theTerm = () => {
  const t = xterm.instances[0];
  if (!t) throw new Error('no terminal');
  return t;
};
const activate = (uri: string): void => {
  const handler = theTerm().options.linkHandler as { activate(e: MouseEvent, text: string): void; allowNonHttpProtocols?: boolean };
  handler.activate(new MouseEvent('click'), uri);
};

describe('TerminalView links', () => {
  it('opens an OSC 8 hyperlink through openInBrowser, not xterm', () => {
    view();
    activate('https://example.com/a?b=1');
    expect(openInBrowser).toHaveBeenCalledWith('https://example.com/a?b=1');
    activate('http://localhost:5173/');
    expect(openInBrowser).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it.each(['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'vscode://file/x', 'not a url', ''])(
    'never opens %j',
    (uri) => {
      view();
      activate(uri);
      expect(openInBrowser).not.toHaveBeenCalled();
    },
  );

  it('keeps xterm from passing on anything but http(s)', () => {
    view();
    expect((theTerm().options.linkHandler as { allowNonHttpProtocols?: boolean }).allowNonHttpProtocols).toBe(false);
  });

  it('typed links go the same way', () => {
    view();
    const handler = xterm.webLinkHandlers[0];
    if (!handler) throw new Error('no web-links addon');
    handler(new MouseEvent('click'), 'https://example.com/');
    expect(openInBrowser).toHaveBeenCalledWith('https://example.com/');
    handler(new MouseEvent('click'), 'file:///etc/passwd');
    expect(openInBrowser).toHaveBeenCalledTimes(1);
  });
});

describe('TerminalView theme', () => {
  it('takes its colours from the theme when it opens', () => {
    view();
    expect(theTerm().options.theme).toMatchObject({ background: '#f2efe6', foreground: '#0a1118', cursor: '#0a1118' });
  });

  it('recolours an open terminal when the colour scheme changes', () => {
    view();
    expect(schemeListeners.size).toBe(1);
    document.documentElement.style.setProperty('--bg', '#0a0f16');
    document.documentElement.style.setProperty('--text', '#f2efe6');
    act(() => schemeListeners.forEach((l) => l({ matches: true })));
    expect(theTerm().options.theme).toMatchObject({ background: '#0a0f16', foreground: '#f2efe6', cursor: '#f2efe6' });
  });

  it('stops listening when it closes', () => {
    const { unmount } = view();
    unmount();
    expect(schemeListeners.size).toBe(0);
    expect(theTerm().disposed).toBe(true);
  });

  it('opens where the engine has no matchMedia', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    view();
    expect(theTerm().options.theme).toMatchObject({ background: '#f2efe6' });
  });
});
