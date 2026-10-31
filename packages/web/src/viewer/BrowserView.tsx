import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { api, type BrowserLiveEvent, type BrowserLiveState, type BrowserPanelInput } from '../state/api.js';
import { SseClient, type SseConnect } from '../state/sse.js';
import { apiUrl } from '../state/transport.js';
import { oneLine } from './browser.js';

/** A frame is shown only as plain base64 under the fixed inert type below, never anything else. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Keys with no character of their own that the page gets as they are. */
const NAMED_KEYS: ReadonlySet<string> = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/** Wheel movement is added up and sent this often, so a flick isn't dozens of calls. */
const WHEEL_INTERVAL_MS = 100;

/** What a key press in the panel sends to the page; null for one that stays here (Ctrl+V, which arrives as a paste). */
export function panelKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): BrowserPanelInput | null {
  const modified = e.ctrlKey || e.metaKey || e.altKey;
  if (!modified && e.key.length === 1) return { type: 'text', text: e.key };
  const chord = `${e.ctrlKey ? 'Control+' : ''}${e.metaKey ? 'Meta+' : ''}${e.altKey ? 'Alt+' : ''}`;
  if (NAMED_KEYS.has(e.key)) return { type: 'key', key: `${chord}${e.shiftKey ? 'Shift+' : ''}${e.key}` };
  if (modified && /^[a-uw-z0-9]$/i.test(e.key)) return { type: 'key', key: `${chord}${e.key}` };
  return null;
}

/** Where a pointer is on the picture, as fractions of its size. */
function fractionsOn(e: MouseEvent<HTMLElement>): { x: number; y: number } {
  const box = e.currentTarget.getBoundingClientRect();
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return { x: clamp((e.clientX - box.left) / (box.width || 1)), y: clamp((e.clientY - box.top) / (box.height || 1)) };
}

/** Forgets the sign-ins and cookie choices every chat's browser shares. Asks once more first: there is no undo. */
function ForgetSignIns(): JSX.Element {
  const [step, setStep] = useState<'idle' | 'confirm' | 'done' | 'failed'>('idle');
  async function forget(): Promise<void> {
    try {
      await api.browser.forgetSignIns();
      setStep('done');
    } catch {
      setStep('failed');
    }
  }
  if (step === 'done') return <span className="text-xs text-[var(--text-muted)]">Forgotten.</span>;
  return (
    <button type="button" onClick={() => (step === 'confirm' ? void forget() : setStep('confirm'))} title="Sign-ins and cookie choices made in the model's browser, for every chat" className="btn px-2 py-0.5 text-xs">
      {step === 'idle' ? 'Forget sign-ins' : step === 'confirm' ? 'Forget them all?' : "Couldn't forget them. Try again"}
    </button>
  );
}

/**
 * The model's browser in a chat's viewer (spec 2026-10-12-model-browser-design
 * §6): JPEG frames from the server's screencast, the page's address and title,
 * and Close browser. Clicks, scrolling, typing and pasting on the picture go to
 * the page, so a person can step in from any device; where the browser is a
 * real window, Show window brings it up. `connect` is for tests.
 */
export function BrowserView({ chatId, connect }: { chatId: string; connect?: SseConnect }): JSX.Element {
  const [state, setState] = useState<BrowserLiveState | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One at a time and in order, or fast typing could arrive scrambled.
  const sending = useRef<Promise<unknown>>(Promise.resolve());
  const wheel = useRef<{ x: number; y: number; dy: number; timer: ReturnType<typeof setTimeout> | null }>({ x: 0, y: 0, dy: 0, timer: null });
  const surface = useRef<HTMLDivElement>(null);

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

  function send(event: BrowserPanelInput): void {
    sending.current = sending.current.then(() => api.browser.input(chatId, event)).catch(() => setError("That didn't reach the page. Please try again."));
  }

  function onWheel(e: WheelEvent<HTMLImageElement>): void {
    const w = wheel.current;
    Object.assign(w, fractionsOn(e));
    w.dy = Math.max(-5000, Math.min(5000, w.dy + e.deltaY));
    w.timer ??= setTimeout(() => {
      send({ type: 'wheel', x: w.x, y: w.y, dy: w.dy });
      w.dy = 0;
      w.timer = null;
    }, WHEEL_INTERVAL_MS);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const event = panelKey(e);
    if (!event) return;
    e.preventDefault();
    send(event);
  }

  async function show(): Promise<void> {
    setError(null);
    try {
      await api.browser.show(chatId);
    } catch {
      setError("Couldn't bring the window up. Please try again.");
    }
  }

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
  if (!state.open) {
    return (
      <div className="space-y-2 p-3">
        <p className="text-sm text-[var(--text-muted)]">The model hasn't opened a page in this chat.</p>
        <ForgetSignIns />
      </div>
    );
  }
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
        <ForgetSignIns />
        {state.visible && (
          <button type="button" onClick={() => void show()} className="btn px-2 py-0.5">
            Show window
          </button>
        )}
        <button type="button" onClick={() => void close()} className="btn px-2 py-0.5">
          Close browser
        </button>
      </div>
      {error && (
        <p role="alert" className="px-3 py-1 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      <div
        ref={surface}
        tabIndex={0}
        role="group"
        aria-label="The page. Click, scroll and type here to use it yourself."
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (text !== '') send({ type: 'text', text });
        }}
        className="flex min-h-0 flex-1 items-center justify-center bg-[var(--bg-sunken)] p-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
      >
        {frame ? (
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt="Live view of the model's browser"
            draggable={false}
            onClick={(e) => {
              surface.current?.focus();
              send({ type: 'click', ...fractionsOn(e) });
            }}
            onWheel={onWheel}
            className="max-h-full max-w-full cursor-pointer object-contain"
          />
        ) : (
          <p className="text-xs text-[var(--text-faint)]">Waiting for the page to draw…</p>
        )}
      </div>
    </div>
  );
}
