import {
  NextcloudError,
  type BookmarkFields, type NextcloudClient, type RawBoard, type RawBookmark, type RawCard, type RawCardPut,
  type RawCollective, type RawLabel, type RawPage, type RawStack,
} from '../../src/nextcloud/client.js';

/** A Deck column, with the board it sits on. Its cards are the `cards` whose `stackId` is its id. */
export interface FakeStack { id: number; boardId: number; title: string; order: number }
/** A seeded card: `stackId` says where it lives. */
export type FakeCard = RawCard & { stackId: number };
/** A Collectives page, with the collective it belongs to and its markdown. */
export type FakePage = RawPage & { collectiveId: number; text?: string };

/** What the fake starts with. Every field is optional, so a test seeds only what it needs. */
export interface FakeSeed {
  baseUrl?: string;
  user?: string;
  displayName?: string;
  apps?: Partial<{ deck: boolean; collectives: boolean; bookmarks: boolean }>;
  boards?: RawBoard[];
  stacks?: FakeStack[];
  cards?: FakeCard[];
  collectives?: RawCollective[];
  pages?: FakePage[];
  bookmarks?: RawBookmark[];
}

const clone = <T>(v: T): T => structuredClone(v);
const notFound = () => new NextcloudError('nextcloud-not-found', 'Nextcloud answered HTTP 404.');
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * An in-memory Nextcloud for tests: Deck boards, stacks, cards and labels,
 * Collectives pages with their text, and Bookmarks. It behaves like the real
 * server as `httpNextcloudClient` sees it (an unknown id is
 * `nextcloud-not-found`), records every call in `calls` and every write body in
 * `bodies`, and hands out copies so a caller can't change its state by accident.
 * Tests read the state back through `card()` / `hasCard()` or the `data` field.
 */
export class FakeNextcloudClient implements NextcloudClient {
  readonly baseUrl: string;
  readonly user: string;
  displayName: string;
  /** What `appsAvailable` reports; flip one off to fake an app that isn't installed. */
  apps: { deck: boolean; collectives: boolean; bookmarks: boolean };
  data: {
    boards: RawBoard[];
    stacks: FakeStack[];
    cards: FakeCard[];
    collectives: RawCollective[];
    pages: FakePage[];
    bookmarks: RawBookmark[];
  };

  /** Each call as `<method> <args...>`, e.g. `'deckReorder 1 10 5 11 0'`. */
  readonly calls: string[] = [];
  /** The body of every write, keyed by its `calls` entry. */
  readonly bodies: Array<{ call: string; body: unknown }> = [];

  /** The documented reorder route answers but doesn't move the card. */
  ignoreReorder = false;
  /** The web UI's internal reorder route answers but doesn't move the card either. */
  ignoreInternalReorder = false;
  /** The next call (any method) throws this, once. */
  fail: NextcloudError | null = null;
  /** Every call to the named method throws this, until cleared. */
  failOn: { call: keyof NextcloudClient; error: NextcloudError } | null = null;

  constructor(seed: FakeSeed = {}) {
    this.baseUrl = seed.baseUrl ?? 'https://nc.example';
    this.user = seed.user ?? 'adam';
    this.displayName = seed.displayName ?? 'Adam';
    this.apps = { deck: true, collectives: true, bookmarks: true, ...seed.apps };
    this.data = {
      boards: clone(seed.boards ?? []),
      stacks: clone(seed.stacks ?? []),
      cards: clone(seed.cards ?? []),
      collectives: clone(seed.collectives ?? []),
      pages: clone(seed.pages ?? []),
      bookmarks: clone(seed.bookmarks ?? []),
    };
  }

  /** The stored card (not a copy). Throws if it isn't there. */
  card(id: number): FakeCard {
    const c = this.data.cards.find((x) => x.id === id);
    if (!c) throw new Error(`fake: no card ${id}`);
    return c;
  }

  hasCard(id: number): boolean {
    return this.data.cards.some((x) => x.id === id);
  }

  private record(method: keyof NextcloudClient, args: unknown[], body?: unknown): void {
    const call = [method, ...args].join(' ');
    this.calls.push(call);
    if (body !== undefined) this.bodies.push({ call, body: clone(body) });
    if (this.fail) {
      const err = this.fail;
      this.fail = null;
      throw err;
    }
    if (this.failOn && this.failOn.call === method) throw this.failOn.error;
  }

  private board(id: number): RawBoard {
    const b = this.data.boards.find((x) => x.id === id);
    if (!b) throw notFound();
    return b;
  }

  private stack(boardId: number, stackId: number): FakeStack {
    const s = this.data.stacks.find((x) => x.id === stackId && x.boardId === boardId);
    if (!s) throw notFound();
    return s;
  }

  /** The card at that board/stack/card address, as the card routes require. */
  private cardAt(boardId: number, stackId: number, cardId: number): FakeCard {
    this.stack(boardId, stackId);
    const c = this.data.cards.find((x) => x.id === cardId && x.stackId === stackId);
    if (!c) throw notFound();
    return c;
  }

  private stacksOf(boardId: number, archived: boolean): RawStack[] {
    this.board(boardId);
    return this.data.stacks
      .filter((s) => s.boardId === boardId)
      .map((s) => ({
        id: s.id,
        boardId: s.boardId,
        title: s.title,
        order: s.order,
        cards: clone(
          this.data.cards
            .filter((c) => c.stackId === s.id && Boolean(c.archived) === archived)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        ),
      }));
  }

  private nextId(ids: number[]): number {
    return Math.max(0, ...ids) + 1;
  }

  async currentUser() {
    this.record('currentUser', []);
    return { id: this.user, displayName: this.displayName };
  }

  async appsAvailable() {
    this.record('appsAvailable', []);
    return { ...this.apps };
  }

  // Deck

  async deckBoards(): Promise<RawBoard[]> {
    this.record('deckBoards', []);
    return clone(this.data.boards);
  }

  async deckBoard(boardId: number): Promise<RawBoard> {
    this.record('deckBoard', [boardId]);
    return clone({ labels: [], ...this.board(boardId) });
  }

  async deckStacks(boardId: number): Promise<RawStack[]> {
    this.record('deckStacks', [boardId]);
    return this.stacksOf(boardId, false);
  }

  async deckArchivedStacks(boardId: number): Promise<RawStack[]> {
    this.record('deckArchivedStacks', [boardId]);
    return this.stacksOf(boardId, true);
  }

  async deckCard(boardId: number, stackId: number, cardId: number): Promise<RawCard> {
    this.record('deckCard', [boardId, stackId, cardId]);
    return clone(this.cardAt(boardId, stackId, cardId));
  }

  async deckPutCard(boardId: number, stackId: number, cardId: number, body: RawCardPut): Promise<RawCard> {
    this.record('deckPutCard', [boardId, stackId, cardId], body);
    const c = this.cardAt(boardId, stackId, cardId);
    c.title = body.title;
    c.type = body.type;
    c.owner = body.owner ? { uid: body.owner } : null;
    c.description = body.description;
    c.order = body.order;
    c.duedate = body.duedate;
    if ('done' in body) c.done = body.done ?? null;
    c.archived = body.archived;
    return clone(c);
  }

  async deckCreateCard(
    boardId: number,
    stackId: number,
    body: { title: string; type: 'plain'; order: number; description?: string },
  ): Promise<RawCard> {
    this.record('deckCreateCard', [boardId, stackId], body);
    this.stack(boardId, stackId);
    const c: FakeCard = {
      id: this.nextId(this.data.cards.map((x) => x.id)),
      title: body.title,
      type: body.type,
      order: body.order,
      description: body.description ?? '',
      stackId,
      labels: [],
      duedate: null,
      done: null,
      archived: false,
      owner: { uid: this.user },
      createdAt: nowSeconds(),
    };
    this.data.cards.push(c);
    return clone(c);
  }

  async deckDeleteCard(boardId: number, stackId: number, cardId: number): Promise<void> {
    this.record('deckDeleteCard', [boardId, stackId, cardId]);
    const c = this.cardAt(boardId, stackId, cardId);
    this.data.cards = this.data.cards.filter((x) => x !== c);
  }

  async deckReorder(boardId: number, stackId: number, cardId: number, toStackId: number, order: number): Promise<void> {
    this.record('deckReorder', [boardId, stackId, cardId, toStackId, order], { order, stackId: toStackId });
    const c = this.cardAt(boardId, stackId, cardId);
    if (this.ignoreReorder) return;
    this.stack(boardId, toStackId);
    c.stackId = toStackId;
    c.order = order;
  }

  async deckReorderInternal(cardId: number, toStackId: number, order: number): Promise<void> {
    this.record('deckReorderInternal', [cardId, toStackId, order], { stackId: toStackId, order });
    const c = this.data.cards.find((x) => x.id === cardId);
    if (!c) throw notFound();
    if (this.ignoreInternalReorder) return;
    if (!this.data.stacks.some((s) => s.id === toStackId)) throw notFound();
    c.stackId = toStackId;
    c.order = order;
  }

  async deckAssignLabel(boardId: number, stackId: number, cardId: number, labelId: number): Promise<void> {
    this.record('deckAssignLabel', [boardId, stackId, cardId, labelId], { labelId });
    const c = this.cardAt(boardId, stackId, cardId);
    const label = (this.board(boardId).labels ?? []).find((l) => l.id === labelId);
    if (!label) throw notFound();
    const labels: RawLabel[] = c.labels ?? [];
    if (!labels.some((l) => l.id === labelId)) labels.push(clone(label));
    c.labels = labels;
  }

  async deckRemoveLabel(boardId: number, stackId: number, cardId: number, labelId: number): Promise<void> {
    this.record('deckRemoveLabel', [boardId, stackId, cardId, labelId], { labelId });
    const c = this.cardAt(boardId, stackId, cardId);
    c.labels = (c.labels ?? []).filter((l) => l.id !== labelId);
  }

  // Collectives

  async collectives(): Promise<RawCollective[]> {
    this.record('collectives', []);
    return clone(this.data.collectives);
  }

  async collectivePages(collectiveId: number): Promise<RawPage[]> {
    this.record('collectivePages', [collectiveId]);
    if (!this.data.collectives.some((c) => c.id === collectiveId)) throw notFound();
    return this.data.pages
      .filter((p) => p.collectiveId === collectiveId)
      .map(({ text: _text, ...page }) => clone(page));
  }

  async pageText(page: RawPage): Promise<string> {
    this.record('pageText', [page.id]);
    const p = this.data.pages.find((x) => x.id === page.id);
    if (!p) throw notFound();
    return p.text ?? '';
  }

  // Bookmarks

  async bookmarks(tag: string): Promise<RawBookmark[]> {
    this.record('bookmarks', [tag]);
    return clone(this.data.bookmarks.filter((b) => (b.tags ?? []).includes(tag)));
  }

  async bookmarkCreate(fields: BookmarkFields): Promise<RawBookmark> {
    this.record('bookmarkCreate', [], fields);
    const b: RawBookmark = {
      id: this.nextId(this.data.bookmarks.map((x) => x.id)),
      url: fields.url ?? '',
      title: fields.title ?? fields.url ?? '',
      description: fields.description ?? '',
      tags: [...(fields.tags ?? [])],
      added: nowSeconds(),
    };
    this.data.bookmarks.push(b);
    return clone(b);
  }

  async bookmarkUpdate(id: number, fields: BookmarkFields): Promise<RawBookmark> {
    this.record('bookmarkUpdate', [id], fields);
    const b = this.data.bookmarks.find((x) => x.id === id);
    if (!b) throw notFound();
    if (fields.url !== undefined) b.url = fields.url;
    if (fields.title !== undefined) b.title = fields.title;
    if (fields.description !== undefined) b.description = fields.description;
    if (fields.tags !== undefined) b.tags = [...fields.tags];
    return clone(b);
  }

  async bookmarkDelete(id: number): Promise<void> {
    this.record('bookmarkDelete', [id]);
    if (!this.data.bookmarks.some((x) => x.id === id)) throw notFound();
    this.data.bookmarks = this.data.bookmarks.filter((x) => x.id !== id);
  }
}
