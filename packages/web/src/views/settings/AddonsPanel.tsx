import { useEffect, useRef, type JSX } from 'react';
import type { AddonView } from '../../state/api/addons.js';
import { onAppEvent } from '../../state/appEventListeners.js';
import { apiUrl, currentToken, serverUrl } from '../../state/transport.js';

/** The app's own colour and font tokens, handed to a page so it can look like the rest of OtherBench. */
const THEME_TOKENS = ['--bg', '--bg-raised', '--bg-sunken', '--text', '--text-muted', '--text-faint', '--border', '--border-strong', '--accent', '--accent-text', '--danger', '--success', '--warn', '--font-sans', '--font-mono', '--font-label'];

function theme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(THEME_TOKENS.map((t) => [t, style.getPropertyValue(t).trim()]).filter(([, v]) => v !== ''));
}

/** The server's origin: an add-on page is served from there, and only messages from there are answered. */
function serverOrigin(): string {
  return new URL(serverUrl('/'), window.location.href).origin;
}

interface AddonFrameProps {
  addon: AddonView;
  onOpenChat?: (chatId: string) => void;
}

/**
 * One add-on's settings page, in a frame served by the server (`/addons/<id>/`). The page asks for what it needs with
 * `otherbench-addon-ready`; only a message from this frame, from the server's origin, is answered, with the API address,
 * the desktop app's token (null elsewhere) and the theme. The page may ask to open a chat; it is told when its add-on
 * changed (`addon-changed` for its id). The frame may not navigate the app or open windows.
 */
function AddonFrame({ addon, onOpenChat }: AddonFrameProps): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null);
  const openChat = useRef(onOpenChat);
  useEffect(() => {
    openChat.current = onOpenChat;
  }, [onOpenChat]);

  useEffect(() => {
    const origin = serverOrigin();
    const post = (message: unknown): void => ref.current?.contentWindow?.postMessage(message, origin);
    const onMessage = (e: MessageEvent): void => {
      if (e.origin !== origin || e.source === null || e.source !== ref.current?.contentWindow) return;
      const data = e.data as { type?: unknown; chatId?: unknown } | null;
      if (data?.type === 'otherbench-addon-ready') post({ type: 'otherbench-host', apiBase: apiUrl(''), token: currentToken(), theme: theme() });
      else if (data?.type === 'otherbench-open-chat' && typeof data.chatId === 'string') openChat.current?.(data.chatId);
    };
    window.addEventListener('message', onMessage);
    const off = onAppEvent((e) => {
      if (e.type === 'addon-changed' && e.id === addon.id) post({ type: 'otherbench-changed' });
    });
    return () => {
      window.removeEventListener('message', onMessage);
      off();
    };
  }, [addon.id]);

  return (
    <iframe
      ref={ref}
      title={`${addon.name} settings`}
      src={serverUrl(`/addons/${addon.id}/`)}
      sandbox="allow-scripts allow-same-origin allow-forms"
      className="h-[70vh] w-full rounded border border-[var(--border)] bg-[var(--bg)]"
    />
  );
}

export interface AddonsPanelProps {
  addons: readonly AddonView[];
  /** Opens a chat (closing Settings), when a page asks. */
  onOpenChat?: (chatId: string) => void;
}

/**
 * Settings → Add-ons (docs/features/addons.md): the add-ons installed on this machine, each loaded one's own settings
 * page, and why any didn't load. Only shown when there is at least one. Nothing here installs or removes one.
 */
export function AddonsPanel({ addons, onOpenChat }: AddonsPanelProps): JSX.Element {
  return (
    <div data-testid="addons-panel" className="max-w-3xl space-y-6 text-sm">
      {addons.map((a) => (
        <section key={a.id} className="space-y-2">
          <h3 className="text-sm font-semibold">
            {a.name}
            {a.version !== null && <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">{a.version}</span>}
          </h3>
          {a.status === 'failed' ? (
            <p role="alert" className="text-xs text-[var(--danger)]">
              {a.name} didn&apos;t load: {a.error}
            </p>
          ) : a.settingsPage ? (
            <AddonFrame addon={a} {...(onOpenChat ? { onOpenChat } : {})} />
          ) : (
            <p className="text-xs text-[var(--text-muted)]">Loaded. It has no settings page.</p>
          )}
        </section>
      ))}
    </div>
  );
}
