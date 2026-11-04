import { useEffect, useRef, type JSX } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalInfo } from '@otherbench/core/types/terminal.js';
import { api } from '../../state/api.js';
import { openTerminalFeed } from './feed.js';
import { onColorSchemeChange, openTerminalLink, terminalTheme } from './screen.js';

/** The most one input POST carries (the server's limit is 64 KiB); a bigger paste goes in pieces, in order. */
const INPUT_CHUNK = 60_000;

/**
 * One terminal's screen (spec 2026-10-21-code-terminal-design): xterm.js over
 * the terminal's output (feed.ts), which is followed only while this is mounted. The only
 * module that imports xterm, so tests replace it. Keys go to the shell except
 * the app's own shortcuts (Ctrl+Tab, Ctrl+1-9, Ctrl+`), paste (Ctrl+V, Ctrl+Shift+V)
 * and Ctrl+C with a selection, which copies, as in VS Code. Links, typed or OSC 8,
 * open in the browser only if they're http(s), and the colours follow a light/dark switch.
 */
export function TerminalView({ appId, terminal, focusToken }: { appId: string; terminal: TerminalInfo; focusToken: number }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(),
      // OSC 8 hyperlinks: without this xterm opens them itself, which in the desktop app is a webview window.
      linkHandler: { activate: (_event, uri) => openTerminalLink(uri), allowNonHttpProtocols: false },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri)));
    const stopTheme = onColorSchemeChange(() => {
      term.options.theme = terminalTheme();
    });

    const copySelection = (): void => {
      void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
      term.clearSelection();
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl || e.altKey) return true;
      if (e.key === 'Tab' || e.code === 'Backquote') return false;
      if (/^Digit[1-9]$/.test(e.code) && !e.shiftKey) return false;
      // Left to the browser, whose paste event xterm turns into input.
      if (e.code === 'KeyV') return false;
      if (e.code === 'KeyC' && term.hasSelection()) {
        copySelection();
        return false;
      }
      return true;
    });

    // Typing goes up once per frame, and in order.
    let pending = '';
    let frame = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const flush = (): void => {
      frame = 0;
      const data = pending;
      pending = '';
      for (let i = 0; i < data.length; i += INPUT_CHUNK) {
        const piece = data.slice(i, i + INPUT_CHUNK);
        queue = queue.then(() => api.terminals.input(appId, terminal.id, piece)).catch(() => undefined);
      }
    };
    const onData = term.onData((data) => {
      pending += data;
      if (frame === 0) frame = requestAnimationFrame(flush);
    });

    term.open(el);

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let sent = '';
    const fitNow = (): void => {
      try {
        fit.fit();
      } catch {
        return; // not laid out yet
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const size = `${term.cols}x${term.rows}`;
        if (size === sent) return;
        sent = size;
        void api.terminals.resize(appId, terminal.id, term.cols, term.rows).catch(() => undefined);
      }, 100);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitNow);
    observer?.observe(el);
    fitNow();

    // A stream, or polling when the page has no connection to spare (feed.ts).
    const feed = openTerminalFeed(appId, terminal.id, {
      onReset: (buffer) => {
        term.reset();
        term.write(buffer);
      },
      onOutput: (data) => term.write(data),
    });
    term.focus();

    return () => {
      stopTheme();
      feed.close();
      observer?.disconnect();
      clearTimeout(resizeTimer);
      if (frame !== 0) cancelAnimationFrame(frame);
      flush();
      onData.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [appId, terminal.id]);

  useEffect(() => {
    if (focusToken > 0) termRef.current?.focus();
  }, [focusToken]);

  return <div ref={host} data-terminal="" data-testid="terminal-screen" className="h-full w-full overflow-hidden bg-[var(--bg)] p-1" />;
}
