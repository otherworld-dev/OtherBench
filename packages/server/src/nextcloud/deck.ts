import type {
  DeckBoardView, DeckCardDetail, DeckCardSummary, DeckLabel, DeckStack,
} from '@otherbench/core/types/nextcloud.js';
import { NextcloudError, type NextcloudClient, type RawCard, type RawCardPut, type RawLabel, type RawStack } from './client.js';

/** Deck operations over a `NextcloudClient`, following nc.py's working code (deck_update_card, deck_move_card, _deck_done_one). */

const PREFIX_RE = /^#(\d+)\s+/;
/** Column titles that mean "work has started on this" (nc.py _DECK_DOING_TITLES). */
const DOING_TITLES = new Set(['doing', 'in progress', 'in-progress', 'wip']);

const hasOwnPrefix = (id: number, title: string): RegExpMatchArray | null => {
  const m = PREFIX_RE.exec(title);
  return m && Number(m[1]) === id ? m : null;
};

/** The title without its "#<id> " prefix; a prefix carrying another number is left alone. */
export function stripCardPrefix(id: number, title: string): string {
  const m = hasOwnPrefix(id, title);
  return m ? title.slice(m[0].length) : title;
}

/** The title with a "#<id> " prefix (nc.py deck_prefixed_title); a no-op if it already has this id's. */
export function withCardPrefix(id: number, title: string): string {
  return hasOwnPrefix(id, title) ? title : `#${id} ${title}`;
}

export function isDoingTitle(title: string): boolean {
  return DOING_TITLES.has(title.trim().toLowerCase());
}

const isDoneTitle = (title: string): boolean => title.trim().toLowerCase() === 'done';

export function deckCardUrl(baseUrl: string, boardId: number, cardId: number): string {
  return `${baseUrl}/index.php/apps/deck/board/${boardId}/card/${cardId}`;
}

const toLabel = (l: RawLabel): DeckLabel => ({ id: l.id, title: l.title, color: l.color });

/** Stacks in board order; the index breaks ties, as nc.py deck_doing_target does. */
function ordered(stacks: RawStack[]): RawStack[] {
  return stacks
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order ?? a.i) - (b.s.order ?? b.i) || a.i - b.i)
    .map(({ s }) => s);
}

function toSummary(raw: RawCard, stackId: number, archived: boolean): DeckCardSummary {
  return {
    id: raw.id,
    title: stripCardPrefix(raw.id, raw.title ?? ''),
    stackId,
    labels: (raw.labels ?? []).map(toLabel),
    duedate: raw.duedate ?? null,
    // Deck sends a timestamp, null, or (older servers) a boolean.
    done: Boolean(raw.done),
    archived,
  };
}

export async function boardView(client: NextcloudClient, boardId: number): Promise<DeckBoardView> {
  const [board, stacks, archivedStacks] = await Promise.all([
    client.deckBoard(boardId),
    client.deckStacks(boardId),
    client.deckArchivedStacks(boardId),
  ]);
  const sorted = ordered(stacks);
  const view: DeckStack[] = sorted.map((s) => ({
    id: s.id,
    title: s.title,
    order: s.order,
    cards: (s.cards ?? []).filter((c) => !c.archived).map((c) => toSummary(c, s.id, false)),
  }));
  const archived = ordered(archivedStacks).flatMap((s) => (s.cards ?? []).map((c) => toSummary(c, s.id, true)));
  return {
    board: { id: board.id, title: board.title },
    stacks: view,
    archived,
    labels: (board.labels ?? []).map(toLabel),
    doingStackId: sorted.find((s) => isDoingTitle(s.title))?.id ?? null,
    url: `${client.baseUrl}/index.php/apps/deck/board/${board.id}`,
  };
}

/** Where a card lives: its board, its stack and whether it was found among the archived cards. */
interface Located { boardId: number; boardTitle: string | null; stack: RawStack; card: RawCard; archived: boolean }

async function onBoard(client: NextcloudClient, boardId: number, cardId: number): Promise<Omit<Located, 'boardTitle'> | null> {
  for (const archived of [false, true]) {
    const stacks = archived ? await client.deckArchivedStacks(boardId) : await client.deckStacks(boardId);
    for (const stack of stacks) {
      const card = (stack.cards ?? []).find((c) => c.id === cardId);
      if (card) return { boardId, stack, card, archived };
    }
  }
  return null;
}

/**
 * Deck has no "card by id" route: try the preferred board (active, then
 * archived), then every other board. A preferred board that's gone (deleted,
 * or no longer shared) is a miss, not a failure, so an app linked to a stale
 * board can still open its cards.
 */
async function locate(client: NextcloudClient, cardId: number, preferBoardId?: number | null): Promise<Located> {
  if (preferBoardId != null) {
    let hit: Awaited<ReturnType<typeof onBoard>> = null;
    try {
      hit = await onBoard(client, preferBoardId, cardId);
    } catch (e) {
      if (!(e instanceof NextcloudError) || e.code !== 'nextcloud-not-found') throw e;
    }
    if (hit) return { ...hit, boardTitle: null };
  }
  for (const board of await client.deckBoards()) {
    if (board.id === preferBoardId || (typeof board.deletedAt === 'number' && board.deletedAt > 0)) continue;
    const hit = await onBoard(client, board.id, cardId);
    if (hit) return { ...hit, boardTitle: board.title };
  }
  throw new NextcloudError('nextcloud-not-found', `Deck card #${cardId} isn't on any board this account can see.`);
}

/** The full card (the stacks listing can abbreviate the description) as a DeckCardDetail. */
async function detail(client: NextcloudClient, at: Located): Promise<DeckCardDetail> {
  const [card, boardTitle] = await Promise.all([
    client.deckCard(at.boardId, at.stack.id, at.card.id),
    at.boardTitle ?? client.deckBoard(at.boardId).then((b) => b.title),
  ]);
  return {
    ...toSummary(card, at.stack.id, at.archived || Boolean(card.archived)),
    description: card.description ?? '',
    boardId: at.boardId,
    boardTitle,
    stackTitle: at.stack.title,
    createdAt: typeof card.createdAt === 'number' ? card.createdAt : null,
    url: deckCardUrl(client.baseUrl, at.boardId, card.id),
  };
}

export async function findCard(client: NextcloudClient, cardId: number, preferBoardId?: number | null): Promise<DeckCardDetail> {
  return detail(client, await locate(client, cardId, preferBoardId));
}

/** GET + merge + PUT, so the fields not being changed are kept (nc.py deck_update_card). Deck's PUT replaces the whole card. */
async function putCard(
  client: NextcloudClient, boardId: number, stackId: number, cardId: number,
  changes: (card: RawCard) => Partial<RawCardPut>,
): Promise<RawCard> {
  const card = await client.deckCard(boardId, stackId, cardId);
  const owner = card.owner && typeof card.owner === 'object' ? card.owner.uid : card.owner;
  const payload: RawCardPut = {
    title: card.title,
    type: card.type || 'plain',
    owner: typeof owner === 'string' ? owner : null,
    description: card.description ?? '',
    order: card.order ?? 0,
    duedate: card.duedate ?? null,
    done: card.done ?? null,
    archived: card.archived ?? false,
    ...changes(card),
  };
  return client.deckPutCard(boardId, stackId, cardId, payload);
}

export async function createCard(
  client: NextcloudClient, boardId: number, stackId: number, input: { title: string; description?: string },
): Promise<DeckCardDetail> {
  const created = await client.deckCreateCard(boardId, stackId, {
    title: input.title,
    type: 'plain',
    order: 999,
    ...(input.description ? { description: input.description } : {}),
  });
  // The id is the server's, so the "#<id> " prefix goes on in a follow-up update.
  await putCard(client, boardId, stackId, created.id, (c) => ({ title: withCardPrefix(created.id, c.title) }));
  return findCard(client, created.id, boardId);
}

export async function updateCard(
  client: NextcloudClient, cardId: number,
  patch: { title?: string; description?: string; duedate?: string | null },
  preferBoardId?: number | null,
): Promise<DeckCardDetail> {
  const at = await locate(client, cardId, preferBoardId);
  await putCard(client, at.boardId, at.stack.id, cardId, (c) => ({
    // A retitle keeps the card number on cards that carry one, and adds none to cards that don't.
    ...(patch.title !== undefined
      ? { title: hasOwnPrefix(cardId, c.title ?? '') ? withCardPrefix(cardId, patch.title) : patch.title }
      : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.duedate !== undefined ? { duedate: patch.duedate } : {}),
  }));
  return detail(client, at);
}

/** Where the card is on its board now, active or archived; null if it's gone from the board. */
async function stackNow(client: NextcloudClient, boardId: number, cardId: number): Promise<RawStack | null> {
  return (await onBoard(client, boardId, cardId))?.stack ?? null;
}

/**
 * Moves in place, keeping the card id. Tries the documented route, checks the
 * card really moved (some servers ignore the target stack), then the web UI's
 * internal route. Never deletes and recreates the card: if neither route
 * moves it, that's `deck-move-ignored` and the card is as it was.
 */
async function moveLocated(client: NextcloudClient, at: Located, toStackId: number): Promise<void> {
  if (at.stack.id === toStackId) return;
  const cardId = at.card.id;
  await client.deckReorder(at.boardId, at.stack.id, cardId, toStackId, 0);
  let now = await stackNow(client, at.boardId, cardId);
  if (now?.id === toStackId) return;
  try {
    await client.deckReorderInternal(cardId, toStackId, 0);
  } catch (e) {
    // Not a published API: a server without it, or refusing it, has simply not moved the card.
    if (!(e instanceof NextcloudError) || (e.code !== 'nextcloud-not-found' && e.code !== 'nextcloud-failed')) throw e;
  }
  now = await stackNow(client, at.boardId, cardId);
  if (now?.id === toStackId) return;
  const where = (now ?? at.stack).title;
  throw new NextcloudError('deck-move-ignored', `Nextcloud didn't move the card. It's still in ${where}.`);
}

export async function moveCard(client: NextcloudClient, cardId: number, toStackId: number, preferBoardId?: number | null): Promise<void> {
  const at = await locate(client, cardId, preferBoardId);
  if (at.stack.id === toStackId) return;
  const stacks = await client.deckStacks(at.boardId);
  if (!stacks.some((s) => s.id === toStackId)) {
    throw new NextcloudError('nextcloud-not-found', "That column isn't on the card's board.");
  }
  await moveLocated(client, at, toStackId);
}

/**
 * nc.py `deck done`: move to the board's "Done" column if it has one, then
 * mark done, then archive. The move goes first, so a failed move leaves the
 * card neither marked nor archived.
 */
export async function completeCard(client: NextcloudClient, cardId: number, preferBoardId?: number | null): Promise<void> {
  const at = await locate(client, cardId, preferBoardId);
  const doneStack = ordered(await client.deckStacks(at.boardId)).find((s) => isDoneTitle(s.title));
  let stackId = at.stack.id;
  if (doneStack && doneStack.id !== stackId) {
    await moveLocated(client, at, doneStack.id);
    stackId = doneStack.id;
  }
  await putCard(client, at.boardId, stackId, cardId, () => ({ done: new Date().toISOString() }));
  await putCard(client, at.boardId, stackId, cardId, () => ({ archived: true }));
}

/** Clears done and unarchives; the card stays in its column. */
export async function reopenCard(client: NextcloudClient, cardId: number, preferBoardId?: number | null): Promise<void> {
  const at = await locate(client, cardId, preferBoardId);
  await putCard(client, at.boardId, at.stack.id, cardId, () => ({ done: null, archived: false }));
}

export async function archiveCard(client: NextcloudClient, cardId: number, preferBoardId?: number | null): Promise<void> {
  const at = await locate(client, cardId, preferBoardId);
  await putCard(client, at.boardId, at.stack.id, cardId, () => ({ archived: true }));
}

/** Assigns `add` and removes `remove` (label ids on the card's board); labels already in the wanted state are skipped. */
export async function changeLabels(
  client: NextcloudClient, cardId: number, change: { add?: number[]; remove?: number[] }, preferBoardId?: number | null,
): Promise<void> {
  const at = await locate(client, cardId, preferBoardId);
  const has = new Set((at.card.labels ?? []).map((l) => l.id));
  for (const id of change.add ?? []) {
    if (!has.has(id)) await client.deckAssignLabel(at.boardId, at.stack.id, cardId, id);
  }
  for (const id of change.remove ?? []) {
    if (has.has(id)) await client.deckRemoveLabel(at.boardId, at.stack.id, cardId, id);
  }
}

export async function deleteCard(client: NextcloudClient, cardId: number, preferBoardId?: number | null): Promise<void> {
  const at = await locate(client, cardId, preferBoardId);
  await client.deckDeleteCard(at.boardId, at.stack.id, cardId);
}
