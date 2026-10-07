import { randomBytes } from 'node:crypto';

/** How long a viewer link works after it was made or last used (spec 2026-10-07-viewer; from last use, Deck #901). */
export const VIEW_LINK_TTL_MS = 10 * 60_000;
/**
 * The longest a viewer link lives, however often it's used: use keeps it
 * alive for an open page's late loads, but a page in the sandbox may reach
 * the web and could hand its link on, so it can never be kept alive for good.
 */
export const VIEW_LINK_MAX_MS = 60 * 60_000;
/** Links kept at once; the oldest go first. */
export const MAX_VIEW_LINKS = 500;

/**
 * What one `/view/<id>/` link may serve: one file, (for an HTML page) its
 * folder, or an artifact version (Deck #896).
 */
export type ViewLink =
  | {
      chatId: string;
      scope: 'file' | 'folder';
      /** The chat folder (workspace or extra folder) the target was contained in; serving checks it again. */
      root: string;
      /** The file, resolved. A folder link serves files under its folder. */
      target: string;
      expiresAt: number;
    }
  | { chatId: string; scope: 'artifact'; versionId: string; expiresAt: number };

/** A link to make: everything but its expiry. */
export type NewViewLink = ViewLink extends infer L ? (L extends ViewLink ? Omit<L, 'expiresAt'> : never) : never;

/**
 * Capability links for what the browser loads itself (Deck #826): the id is
 * the only credential, so it is 128 random bits, short-lived and kept only in
 * this server's memory.
 */
export class ViewLinks {
  /** Each link, with when it dies whatever its use: VIEW_LINK_MAX_MS after it was made. */
  private readonly links = new Map<string, { link: ViewLink; diesAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  create(link: NewViewLink): string {
    const now = this.now();
    for (const [id, l] of this.links) if (now >= l.link.expiresAt) this.links.delete(id);
    while (this.links.size >= MAX_VIEW_LINKS) {
      const oldest = this.links.keys().next().value;
      if (oldest === undefined) break;
      this.links.delete(oldest);
    }
    const id = randomBytes(16).toString('base64url');
    this.links.set(id, { link: { ...link, expiresAt: now + VIEW_LINK_TTL_MS } as ViewLink, diesAt: now + VIEW_LINK_MAX_MS });
    return id;
  }

  /**
   * The link, which then lives VIEW_LINK_TTL_MS from now (so an open page's
   * late loads still work), but never past VIEW_LINK_MAX_MS from when it was made.
   */
  get(id: string): ViewLink | null {
    const entry = this.links.get(id);
    if (!entry) return null;
    const now = this.now();
    if (now >= entry.link.expiresAt) {
      this.links.delete(id);
      return null;
    }
    entry.link.expiresAt = Math.min(now + VIEW_LINK_TTL_MS, entry.diesAt);
    return entry.link;
  }
}
