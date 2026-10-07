import { useState, type JSX } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import { openSite } from '../desktop/bridge.js';
import { useGruntStore } from '../state/store.js';
import { FileTree } from './FileTree.js';
import { ItemView } from './ItemView.js';
import { viewTabId } from './items.js';
import { useViewerStore, viewerFor } from './state.js';

const BAR_BUTTON = 'rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] disabled:opacity-40';

/**
 * A chat's viewer panel (spec 2026-10-07-viewer): back and forward, an
 * address box for a path or a website, Files, Open as tab and close, over
 * either the Files tree or the open item.
 */
export function ViewerPanel({ chat }: { chat: Chat }): JSX.Element {
  const viewer = useViewerStore((s) => viewerFor(s.viewers, chat.id));
  const { openItem, setOpen, setMode, step } = useViewerStore.getState();
  const openTab = useGruntStore((s) => s.openTab);
  const [address, setAddress] = useState('');
  const current = viewer.index >= 0 ? viewer.history[viewer.index] : undefined;
  const showingItem = viewer.mode === 'item' && current !== undefined;

  function go(): void {
    const value = address.trim();
    if (value === '') return;
    if (/^https?:\/\//i.test(value)) void openSite(value);
    else openItem(chat.id, { kind: 'file', path: value });
    setAddress('');
  }

  return (
    <aside aria-label="Viewer" className="flex h-full min-w-0 flex-col border-l border-[var(--border)] bg-[var(--bg)]">
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1">
        <button type="button" aria-label="Back" disabled={viewer.index <= 0} onClick={() => step(chat.id, -1)} className={BAR_BUTTON}>
          ←
        </button>
        <button type="button" aria-label="Forward" disabled={viewer.index >= viewer.history.length - 1} onClick={() => step(chat.id, 1)} className={BAR_BUTTON}>
          →
        </button>
        <button type="button" aria-pressed={viewer.mode === 'files'} onClick={() => setMode(chat.id, viewer.mode === 'files' && current ? 'item' : 'files')} className={BAR_BUTTON}>
          Files
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input
            aria-label="Open a path or web address"
            placeholder={current?.path ?? 'Path, or https://…'}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-0.5 font-mono text-xs"
          />
        </form>
        {showingItem && (
          <button
            type="button"
            aria-label="Open as tab"
            title="Open this in its own tab"
            onClick={() => {
              openTab(chat.id);
              openTab(viewTabId(chat.id, current));
            }}
            className={BAR_BUTTON}
          >
            ⧉
          </button>
        )}
        <button type="button" aria-label="Close viewer" onClick={() => setOpen(chat.id, false)} className={BAR_BUTTON}>
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {showingItem ? (
          <ItemView key={current.path} chatId={chat.id} item={current} />
        ) : (
          <FileTree chatId={chat.id} onOpen={(path) => openItem(chat.id, { kind: 'file', path })} />
        )}
      </div>
    </aside>
  );
}
