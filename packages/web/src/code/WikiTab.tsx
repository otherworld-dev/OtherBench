import { useEffect, useMemo, useState, type JSX, type MouseEvent } from 'react';
import type { App } from '@otherbench/core/ports/store.js';
import type { WikiPageNode, WikiTree } from '@otherbench/core/types/nextcloud.js';
import { MarkdownBody } from '../components/MarkdownBody.js';
import { openInBrowser } from '../desktop/bridge.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { CodeErrorLine, NO_WIKI_PAGE } from './CodeError.js';
import { stayInApp } from './stayInApp.js';
import { useCodeRefresh } from './useCodeRefresh.js';

const MUTED = 'text-xs text-[var(--text-muted)]';
const EMPTY = 'text-sm text-[var(--text-faint)]';

/** Children of each page (by parent id), each list sorted by title. */
function childrenOf(pages: WikiPageNode[]): Map<number, WikiPageNode[]> {
  const map = new Map<number, WikiPageNode[]>();
  for (const p of pages) {
    if (p.parentId === null) continue;
    const list = map.get(p.parentId);
    if (list) list.push(p);
    else map.set(p.parentId, [p]);
  }
  for (const list of map.values()) list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  return map;
}

/**
 * The Code panel's Wiki tab (spec 2026-10-22-nextcloud-tabs, Goal 4, mockup A):
 * the app's Collectives pages as a read-only tree, and a page opened beside it
 * as markdown. Which folders are open and which page is shown belong to its
 * `owner` and are kept in the store (`wikiViews`); Nextcloud's last answers are
 * kept there too and shown while they're fetched again.
 */
export function WikiTab({ app, owner }: { app: App; owner: string }): JSX.Element {
  const view = useOtherBenchStore((s) => s.wikiViews[owner]);
  const setWikiView = useOtherBenchStore((s) => s.setWikiView);
  const cachedTree = useOtherBenchStore((s) => s.wikiTrees[app.id] ?? null);
  const cacheWikiTree = useOtherBenchStore((s) => s.cacheWikiTree);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  // Kept here, not in the list, so it survives opening a page and coming back.
  const [query, setQuery] = useState('');
  const pagePath = app.wikiPagePath;
  // A tree cached before the app was pointed at another page isn't shown.
  const tree = cachedTree && cachedTree.pagePath === pagePath ? cachedTree : null;
  const refresh = (): void => setReload((n) => n + 1);

  useCodeRefresh(app.id, refresh);
  useEffect(() => setError(null), [app.id, pagePath]);
  useEffect(() => setQuery(''), [owner]);
  useEffect(() => {
    // Nothing to ask for: the server would only answer no-wiki-page.
    if (pagePath === null) return;
    let cancelled = false;
    api.apps.wiki.tree(app.id).then(
      (r) => {
        if (cancelled) return;
        cacheWikiTree(app.id, r);
        setError(null);
      },
      (err: unknown) => !cancelled && setError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [app.id, pagePath, reload, cacheWikiTree]);

  const selected = view?.selected ?? null;
  // The root is open until the owner has chosen otherwise.
  const expanded = view ? view.expanded : tree ? [tree.rootId] : [];
  const open = (id: number | null): void => setWikiView(owner, { expanded, selected: id });
  return (
    <div data-testid="wiki-tab" className="min-w-0">
      {pagePath === null ? (
        <div role="alert" className="text-sm text-[var(--text-muted)]">
          <p>{NO_WIKI_PAGE}</p>
        </div>
      ) : selected === null ? (
        <WikiList
          tree={tree}
          query={query}
          onQuery={setQuery}
          error={error}
          expanded={expanded}
          onExpanded={(ids) => setWikiView(owner, { expanded: ids })}
          onOpen={open}
          onRefresh={refresh}
        />
      ) : (
        <PageView app={app} pageId={selected} tree={tree} onBack={() => setWikiView(owner, { selected: null })} onOpen={open} />
      )}
    </div>
  );
}

function WikiList({
  tree,
  query,
  onQuery,
  error,
  expanded,
  onExpanded,
  onOpen,
  onRefresh,
}: {
  tree: WikiTree | null;
  query: string;
  onQuery: (q: string) => void;
  error: unknown;
  expanded: number[];
  onExpanded: (ids: number[]) => void;
  onOpen: (id: number) => void;
  onRefresh: () => void;
}): JSX.Element {
  const kids = useMemo(() => (tree ? childrenOf(tree.pages) : new Map<number, WikiPageNode[]>()), [tree]);
  const byId = useMemo(() => new Map((tree?.pages ?? []).map((p) => [p.id, p])), [tree]);
  const q = query.trim().toLowerCase();

  // With a query: the matching pages and their ancestors, all shown open.
  const shown = useMemo(() => {
    if (q === '' || !tree) return null;
    const ids = new Set<number>();
    for (const p of tree.pages) {
      if (!p.title.toLowerCase().includes(q)) continue;
      for (let cur: WikiPageNode | undefined = p; cur && !ids.has(cur.id); cur = cur.parentId === null ? undefined : byId.get(cur.parentId)) ids.add(cur.id);
    }
    return ids;
  }, [q, tree, byId]);

  function toggle(id: number): void {
    onExpanded(expanded.includes(id) ? expanded.filter((e) => e !== id) : [...expanded, id]);
  }

  function renderNode(node: WikiPageNode, depth: number): JSX.Element {
    const children = (kids.get(node.id) ?? []).filter((c) => !shown || shown.has(c.id));
    const isFolder = (kids.get(node.id)?.length ?? 0) > 0;
    const isOpen = shown ? true : expanded.includes(node.id);
    return (
      <li key={node.id} data-page={node.id}>
        <div className="flex items-center rounded-sm hover:bg-[var(--bg-sunken)]" style={{ paddingLeft: `${depth * 0.9}rem` }}>
          {isFolder ? (
            <button
              type="button"
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${node.title}`}
              aria-expanded={isOpen}
              disabled={shown !== null}
              onClick={() => toggle(node.id)}
              className="w-5 shrink-0 text-xs text-[var(--text-muted)]"
            >
              <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}
          <button type="button" data-testid={`wiki-row-${node.id}`} onClick={() => onOpen(node.id)} className="min-w-0 flex-1 py-1 text-left text-sm [overflow-wrap:anywhere]">
            {node.title}
          </button>
        </div>
        {isFolder && isOpen && children.length > 0 && <ul>{children.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    );
  }

  const root = tree ? byId.get(tree.rootId) : undefined;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="search"
          aria-label="Find"
          placeholder="Find"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          className="min-w-0 flex-1 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
        />
        <button
          type="button"
          aria-label="Refresh the pages"
          title="Refresh the pages"
          onClick={onRefresh}
          className="shrink-0 rounded px-1 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>
      {error !== null ? (
        <CodeErrorLine error={error} fallback="Couldn't load the pages." />
      ) : !tree ? (
        <p className={EMPTY}>Loading…</p>
      ) : !root ? (
        <p className={EMPTY}>No pages</p>
      ) : shown && !shown.has(root.id) ? (
        <p className={EMPTY}>No pages match</p>
      ) : (
        <ul aria-label="Pages">{renderNode(root, 0)}</ul>
      )}
    </div>
  );
}

function PageView({
  app,
  pageId,
  tree,
  onBack,
  onOpen,
}: {
  app: App;
  pageId: number;
  tree: WikiTree | null;
  onBack: () => void;
  onOpen: (id: number) => void;
}): JSX.Element {
  // Nextcloud's last answer for the page, shown while it's fetched again.
  const page = useOtherBenchStore((s) => s.wikiPages[`${app.id}#${pageId}`] ?? null);
  const cacheWikiPage = useOtherBenchStore((s) => s.cacheWikiPage);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  useCodeRefresh(app.id, () => setReload((n) => n + 1));
  useEffect(() => {
    let cancelled = false;
    api.apps.wiki.page(app.id, pageId).then(
      (r) => {
        if (cancelled) return;
        cacheWikiPage(app.id, r);
        setLoadError(null);
      },
      (err: unknown) => !cancelled && setLoadError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [app.id, pageId, reload, cacheWikiPage]);

  // A link to another page of the tree (`...fileId=<n>`) opens it here, before MarkdownBody would send it to the browser.
  function followPageLink(e: MouseEvent<HTMLElement>): void {
    const link = e.target instanceof Element ? e.target.closest('a') : null;
    const match = /[?&#]fileId=(\d+)(?!\d)/.exec(link?.getAttribute('href') ?? '');
    if (!match || !tree) return;
    const id = Number(match[1]);
    if (!tree.pages.some((p) => p.id === id)) return;
    e.preventDefault();
    e.stopPropagation();
    onOpen(id);
  }

  const back = (
    <button type="button" onClick={onBack} aria-label="Back to Wiki" className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
      <span aria-hidden="true">← Wiki</span>
    </button>
  );

  if (!page) {
    return (
      <div className="space-y-2">
        {back}
        {loadError !== null ? <CodeErrorLine error={loadError} fallback="Couldn't load the page." /> : <p className={EMPTY}>Loading…</p>}
      </div>
    );
  }

  return (
    <div data-testid="wiki-page" className="min-w-0 space-y-3">
      <div className="flex items-center gap-2">
        {back}
        <span className="flex-1" />
        <a
          href={page.url}
          onClick={(e) => {
            e.preventDefault();
            void openInBrowser(page.url);
          }}
          className="text-xs text-[var(--accent)] hover:underline"
        >
          Open in Nextcloud <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div>
        <h3 className="text-sm font-medium [overflow-wrap:anywhere]">{page.title}</h3>
        <p className={MUTED}>{page.breadcrumbs.join(' › ')}</p>
      </div>
      {loadError !== null && <CodeErrorLine error={loadError} fallback="Couldn't refresh the page." />}
      <div onClickCapture={followPageLink} onClick={stayInApp} className="min-w-0 [overflow-wrap:anywhere]">
        {page.markdown.trim() ? <MarkdownBody text={page.markdown} remoteImages={false} /> : <p className={EMPTY}>This page is empty.</p>}
      </div>
    </div>
  );
}
