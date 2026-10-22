import { useEffect, useState, type JSX } from 'react';
import type { App } from '@otherbench/core/ports/store.js';
import type { Bookmark } from '@otherbench/core/types/nextcloud.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Menu } from '../components/Menu.js';
import { openInBrowser } from '../desktop/bridge.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { CodeErrorLine, NO_BOOKMARK_TAG } from './CodeError.js';
import { useCodeRefresh } from './useCodeRefresh.js';

const MUTED = 'text-xs text-[var(--text-muted)]';
const EMPTY = 'text-sm text-[var(--text-faint)]';
const FIELD =
  'w-full rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 text-sm read-only:opacity-60 disabled:opacity-60 focus:border-[var(--accent)] focus:outline-none';

/** Only web links are opened; a `javascript:` or `file:` bookmark from Nextcloud is shown but never followed. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** A link's host and path as the row's second line; an unparseable URL shows as it is. */
function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

/** The "extra tags" field's text as tags: split on commas, trimmed, empty and repeated ones dropped. */
function parseTags(text: string, exclude: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(',')) {
    const t = raw.trim();
    if (t !== '' && t !== exclude && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The Code panel's Links tab (spec 2026-10-22-nextcloud-tabs, Goal 5): the
 * bookmarks under the app's tag, newest first. A click opens a link in the
 * browser; a row's menu edits or deletes it. Nextcloud's last answer is kept in
 * the store and shown while it's fetched again.
 */
export function LinksTab({ app }: { app: App }): JSX.Element {
  const tag = app.bookmarkTag;
  const cachedList = useOtherBenchStore((s) => s.linkLists[app.id] ?? null);
  const cacheLinkList = useOtherBenchStore((s) => s.cacheLinkList);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [deleting, setDeleting] = useState<Bookmark | null>(null);
  const [menu, setMenu] = useState<{ bookmark: Bookmark; x: number; y: number; opener: HTMLElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ error: unknown; fallback: string } | null>(null);
  // A list cached before the app was given another tag isn't shown.
  const list = cachedList && cachedList.tag === tag ? cachedList : null;
  const refresh = (): void => setReload((n) => n + 1);

  useCodeRefresh(app.id, refresh);
  useEffect(() => setError(null), [app.id, tag]);
  useEffect(() => {
    // Nothing to ask for: the server would only answer no-bookmark-tag.
    if (tag === null) return;
    let cancelled = false;
    api.apps.links.list(app.id).then(
      (r) => {
        if (cancelled) return;
        cacheLinkList(app.id, r);
        setError(null);
      },
      (err: unknown) => !cancelled && setError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [app.id, tag, reload, cacheLinkList]);

  /** One user action; the list is fetched again after it. */
  async function act(kind: string, run: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setActionError(null);
    try {
      await run();
      refresh();
      return true;
    } catch (err) {
      console.error(`[otherbench-web] links ${kind} failed:`, err);
      setActionError({ error: err, fallback: kind === 'delete' ? "Couldn't delete the link." : "Couldn't save the link." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (tag === null) {
    return (
      <div data-testid="links-tab" className="min-w-0">
        <div role="alert" className="text-sm text-[var(--text-muted)]">
          <p>{NO_BOOKMARK_TAG}</p>
        </div>
      </div>
    );
  }

  const bookmarks = list ? [...list.bookmarks].sort((a, b) => b.added - a.added) : [];
  return (
    <div data-testid="links-tab" className="min-w-0 space-y-2">
      <div className="flex items-center gap-2">
        <p className={`min-w-0 flex-1 truncate ${MUTED}`}>{list ? `Tag ${tag} · ${bookmarks.length}` : `Tag ${tag}`}</p>
        <button
          type="button"
          aria-expanded={adding}
          onClick={() => {
            setEditing(null);
            setAdding((a) => !a);
          }}
          className="btn shrink-0 px-1.5 py-0 text-xs"
        >
          + Add
        </button>
        <button
          type="button"
          aria-label="Refresh the links"
          title="Refresh the links"
          onClick={refresh}
          className="shrink-0 rounded px-1 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>
      {adding && (
        <LinkForm
          label="New link"
          tag={tag}
          busy={busy}
          submitLabel="Add"
          onCancel={() => setAdding(false)}
          onSubmit={async (f) => {
            const body: { url: string; title?: string; description?: string; tags?: string[] } = { url: f.url };
            if (f.title !== '') body.title = f.title;
            if (f.description !== '') body.description = f.description;
            if (f.tags.length > 0) body.tags = f.tags;
            if (await act('add', () => api.apps.links.add(app.id, body))) setAdding(false);
          }}
        />
      )}
      {error !== null ? (
        <CodeErrorLine error={error} fallback="Couldn't load the links." />
      ) : !list ? (
        <p className={EMPTY}>Loading…</p>
      ) : bookmarks.length === 0 ? (
        <p className={EMPTY}>No links with this tag</p>
      ) : (
        <ul aria-label="Links" className="space-y-0.5">
          {bookmarks.map((b) =>
            editing?.id === b.id ? (
              <li key={b.id} data-link={b.id}>
                <LinkForm
                  label="Edit link"
                  tag={tag}
                  initial={b}
                  busy={busy}
                  submitLabel="Save"
                  onCancel={() => setEditing(null)}
                  onSubmit={async (f) => {
                    // `tags` replaces the set, so the app's own tag goes first, always.
                    if (await act('edit', () => api.apps.links.update(app.id, b.id, { url: f.url, title: f.title, description: f.description, tags: [tag, ...f.tags] }))) setEditing(null);
                  }}
                />
              </li>
            ) : (
              <li key={b.id} data-link={b.id} data-testid={`link-row-${b.id}`} className="flex items-start rounded-sm hover:bg-[var(--bg-sunken)]">
                <a
                  href={b.url}
                  onClick={(e) => {
                    e.preventDefault();
                    if (isWebUrl(b.url)) void openInBrowser(b.url);
                  }}
                  className="min-w-0 flex-1 px-1.5 py-1 text-sm"
                >
                  <span className="block [overflow-wrap:anywhere]">{b.title.trim() === '' ? b.url : b.title}</span>
                  <span className={`block truncate ${MUTED}`}>{hostAndPath(b.url)}</span>
                </a>
                <button
                  type="button"
                  aria-label={`Actions for ${b.title.trim() === '' ? b.url : b.title}`}
                  aria-haspopup="menu"
                  disabled={busy}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMenu({ bookmark: b, x: rect.left, y: rect.bottom, opener: e.currentTarget });
                  }}
                  className="my-1 mr-1 shrink-0 rounded px-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] disabled:opacity-50"
                >
                  <span aria-hidden="true">⋯</span>
                </button>
              </li>
            )
          )}
        </ul>
      )}
      {actionError !== null && <CodeErrorLine error={actionError.error} fallback={actionError.fallback} />}
      {menu && (
        <Menu
          label="Link actions"
          position={{ x: menu.x, y: menu.y }}
          items={[
            {
              id: 'edit',
              label: 'Edit',
              onSelect: () => {
                setAdding(false);
                setEditing(menu.bookmark);
              },
            },
            { id: 'delete', label: 'Delete', danger: true, onSelect: () => setDeleting(menu.bookmark) },
          ]}
          onClose={(reason) => {
            if (reason === 'dismiss') menu.opener.focus();
            setMenu(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this link?"
          confirmLabel="Delete"
          onConfirm={async () => {
            const b = deleting;
            setDeleting(null);
            await act('delete', () => api.apps.links.remove(app.id, b.id));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/** The Add and Edit form: URL (required), title, description and extra tags, with the app's tag shown fixed. */
function LinkForm({
  label,
  tag,
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  tag: string;
  initial?: Bookmark;
  busy: boolean;
  submitLabel: string;
  onSubmit: (f: { url: string; title: string; description: string; tags: string[] }) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [extra, setExtra] = useState(initial ? initial.tags.filter((t) => t !== tag).join(', ') : '');

  return (
    <form
      aria-label={label}
      className="space-y-1.5 rounded-sm border border-[var(--border)] p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim() === '') return;
        void onSubmit({ url: url.trim(), title: title.trim(), description: description.trim(), tags: parseTags(extra, tag) });
      }}
    >
      <input aria-label="URL" placeholder="URL" value={url} readOnly={busy} onChange={(e) => setUrl(e.target.value)} className={FIELD} />
      <input aria-label="Title" placeholder="Title (optional)" value={title} readOnly={busy} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
      <textarea aria-label="Description" placeholder="Description (optional)" value={description} readOnly={busy} rows={2} onChange={(e) => setDescription(e.target.value)} className={`resize-y ${FIELD}`} />
      <div className="flex gap-2">
        <input aria-label="App tag" value={tag} disabled className={`w-1/3 ${FIELD}`} />
        <input aria-label="Extra tags" placeholder="Extra tags, comma-separated" value={extra} readOnly={busy} onChange={(e) => setExtra(e.target.value)} className={FIELD} />
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || url.trim() === ''} className="btn btn-primary px-2.5 py-1">
          {submitLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="btn px-2.5 py-1">
          Cancel
        </button>
      </div>
    </form>
  );
}
