import { randomBytes } from 'node:crypto';

/** How long a viewer link works (spec 2026-10-07-viewer). */
export const VIEW_LINK_TTL_MS = 10 * 60_000;
/** Links kept at once; the oldest go first. */
export const MAX_VIEW_LINKS = 500;

/** What one `/view/<id>/` link may serve: one file, or (for an HTML page) its folder. */
export interface ViewLink {
  chatId: string;
  /** The chat folder (workspace or extra folder) the target was contained in; serving checks it again. */
  root: string;
  /** The file, resolved. A folder link serves files under its folder. */
  target: string;
  scope: 'file' | 'folder';
  expiresAt: number;
}

/**
 * Capability links for what the browser loads itself (Deck #826): the id is
 * the only credential, so it is 128 random bits, short-lived and kept only in
 * this server's memory.
 */
export class ViewLinks {
  private readonly links = new Map<string, ViewLink>();

  constructor(private readonly now: () => number = Date.now) {}

  create(link: Omit<ViewLink, 'expiresAt'>): string {
    const now = this.now();
    for (const [id, l] of this.links) if (now >= l.expiresAt) this.links.delete(id);
    while (this.links.size >= MAX_VIEW_LINKS) {
      const oldest = this.links.keys().next().value;
      if (oldest === undefined) break;
      this.links.delete(oldest);
    }
    const id = randomBytes(16).toString('base64url');
    this.links.set(id, { ...link, expiresAt: now + VIEW_LINK_TTL_MS });
    return id;
  }

  get(id: string): ViewLink | null {
    const link = this.links.get(id);
    if (!link) return null;
    if (this.now() >= link.expiresAt) {
      this.links.delete(id);
      return null;
    }
    return link;
  }
}
