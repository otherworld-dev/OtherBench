import { useEffect, useState, type JSX } from 'react';
import { api, type BrowserLiveEvent, type BrowserLiveState } from '../state/api.js';
import { SseClient, type SseConnect } from '../state/sse.js';
import { apiUrl } from '../state/transport.js';
import { oneLine } from './browser.js';

/** A frame is shown only as plain base64 under the fixed inert type below, never anything else. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The model's browser in a chat's viewer (spec 2026-10-12-model-browser-design
 * §6): view-only JPEG frames from the server's screencast, the page's address
 * and title, and Close browser. `connect` is for tests.
 */
export function BrowserView({ chatId, connect }: { chatId: string; connect?: SseConnect }): JSX.Element {
  const [state, setState] = useState<BrowserLiveState | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(null);
    setFrame(null);
    const show = (s: BrowserLiveState | null | undefined): void => {
      if (!s || typeof s !== 'object') return;
      setState(s);
      if (!s.open) setFrame(null);
    };
    const client = new SseClient<BrowserLiveState, BrowserLiveEvent>({
      url: apiUrl(`/chats/${encodeURIComponent(chatId)}/browser/live`),
      readHello: (payload) => payload as BrowserLiveState,
      onHello: show,
      onEvent: (e) => {
        if (e.type === 'frame') {
          if (typeof e.jpeg === 'string' && BASE64.test(e.jpeg)) setFrame(e.jpeg);
        } else if (e.type === 'state') {
          show(e.state);
        }
      },
      ...(connect ? { connect } : {}),
    });
    client.connect();
    return () => client.close();
  }, [chatId, connect]);

  async function close(): Promise<void> {
    setError(null);
    try {
      await api.browser.close(chatId);
    } catch {
      setError("Couldn't close the browser. Please try again.");
    }
  }

  if (state?.elsewhere) return <p className="p-3 text-sm text-[var(--text-muted)]">The browser is on {oneLine(state.elsewhere)}.</p>;
  if (!state) return <p className="p-3 text-sm text-[var(--text-faint)]">Connecting…</p>;
  if (!state.open) return <p className="p-3 text-sm text-[var(--text-muted)]">The model hasn't opened a page in this chat.</p>;
  const url = oneLine(state.url);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1 text-xs">
        <div className="min-w-0 flex-1">
          {/* The page's own words: <bdi> keeps their direction from spilling into the rest of the bar. */}
          <div className="truncate font-medium">
            <bdi>{oneLine(state.title) || 'Untitled page'}</bdi>
          </div>
          <div className="truncate font-mono text-[var(--text-muted)]" title={url}>
            <bdi>{url}</bdi>
          </div>
        </div>
        <button type="button" onClick={() => void close()} className="btn px-2 py-0.5">
          Close browser
        </button>
      </div>
      {error && (
        <p role="alert" className="px-3 py-1 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--bg-sunken)] p-2">
        {frame ? (
          <img src={`data:image/jpeg;base64,${frame}`} alt="Live view of the model's browser" draggable={false} className="max-h-full max-w-full object-contain" />
        ) : (
          <p className="text-xs text-[var(--text-faint)]">Waiting for the page to draw…</p>
        )}
      </div>
    </div>
  );
}
