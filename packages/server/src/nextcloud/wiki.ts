import type { WikiPage, WikiPageNode, WikiTree } from '@otherbench/core/types/nextcloud.js';
import { NextcloudError, type NextcloudClient, type RawPage } from './client.js';

/** Collectives operations over a `NextcloudClient`, following nc.py's coll_resolve_path / _landing_page. */

const notFound = (what: string) => new NextcloudError('nextcloud-not-found', `${what} was not found in Nextcloud.`);
const isTop = (p: RawPage) => p.parentId === 0 || p.parentId == null;

/** The collective's own page: a top-level Readme.md or flagged landing page, else any top-level page (nc.py _landing_page). */
function landingPage(pages: RawPage[]): RawPage | null {
  return (
    pages.find((p) => isTop(p) && (p.fileName === 'Readme.md' || p.isLandingPage)) ??
    pages.find(isTop) ??
    null
  );
}

interface Resolved {
  pages: RawPage[];
  /** The page at the path. */
  root: RawPage;
  /** The pages from just under the landing page down to `root` (empty when `root` is the landing page). */
  chain: RawPage[];
}

async function resolve(client: NextcloudClient, collective: string, pagePath: string): Promise<Resolved> {
  const found = (await client.collectives()).find((c) => c.name.toLowerCase() === collective.trim().toLowerCase());
  if (!found) throw notFound('The collective');
  const pages = await client.collectivePages(found.id);
  const landing = landingPage(pages);
  if (!landing) throw notFound('The landing page');
  const chain: RawPage[] = [];
  let parent = landing;
  for (const seg of pagePath.split('/').filter((s) => s.trim())) {
    const next = pages.find((p) => p.parentId === parent.id && p.title.toLowerCase() === seg.trim().toLowerCase());
    if (!next) throw notFound('The wiki page');
    chain.push(next);
    parent = next;
  }
  return { pages, root: parent, chain };
}

/** `root` and every page below it, root first. */
function subtree(pages: RawPage[], root: RawPage): RawPage[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    const at = out[i];
    if (at) out.push(...pages.filter((p) => p.parentId === at.id && !out.includes(p)));
  }
  return out;
}

function pageUrl(client: NextcloudClient, collective: string, titles: string[]): string {
  return `${client.baseUrl}/index.php/apps/collectives/${encodeURIComponent(collective)}/${titles.map(encodeURIComponent).join('/')}`;
}

/** The page at `pagePath` (resolved from the landing page down by title, case-insensitive, as nc.py coll_resolve_path) and every page under it. NextcloudError('nextcloud-not-found') for an unknown collective or path. */
export async function wikiTree(client: NextcloudClient, collective: string, pagePath: string): Promise<WikiTree> {
  const { pages, root, chain } = await resolve(client, collective, pagePath);
  const nodes: WikiPageNode[] = subtree(pages, root).map((p) => ({
    id: p.id,
    title: p.title,
    parentId: p.id === root.id ? null : p.parentId,
  }));
  return {
    collective,
    pagePath,
    rootId: root.id,
    pages: nodes,
    url: pageUrl(client, collective, chain.map((p) => p.title)),
  };
}

/** One page of that subtree; NextcloudError('nextcloud-not-found') if `pageId` isn't in it. */
export async function wikiPage(client: NextcloudClient, collective: string, pagePath: string, pageId: number): Promise<WikiPage> {
  const { pages, root, chain } = await resolve(client, collective, pagePath);
  const page = subtree(pages, root).find((p) => p.id === pageId);
  if (!page) throw notFound('The wiki page');
  // Walk up from the page to (not including) the root.
  const below: RawPage[] = [];
  for (let at: RawPage | undefined = page; at && at.id !== root.id; ) {
    below.unshift(at);
    const parentId: number = at.parentId;
    at = pages.find((p) => p.id === parentId);
  }
  return {
    id: page.id,
    title: page.title,
    breadcrumbs: [root, ...below].map((p) => p.title),
    markdown: await client.pageText(page),
    url: pageUrl(client, collective, [...chain, ...below].map((p) => p.title)),
  };
}
