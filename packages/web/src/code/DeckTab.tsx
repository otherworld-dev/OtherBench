import { useEffect, useRef, useState, type JSX } from 'react';
import type { App } from '@otherbench/core/ports/store.js';
import type { DeckBoardView, DeckCardDetail, DeckCardSummary, DeckLabel } from '@otherbench/core/types/nextcloud.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { MarkdownBody } from '../components/MarkdownBody.js';
import { openInBrowser } from '../desktop/bridge.js';
import { formatAge } from '../lib/relativeTime.js';
import { ApiError, api } from '../state/api.js';
import { useOtherBenchStore, type DeckView } from '../state/store.js';
import { CodeErrorLine, NO_DECK_BOARD } from './CodeError.js';
import { startChatFromCard } from './startChatFromCard.js';
import { stayInApp } from './stayInApp.js';
import { useCodeRefresh } from './useCodeRefresh.js';

const MUTED = 'text-xs text-[var(--text-muted)]';
const EMPTY = 'text-sm text-[var(--text-faint)]';
const FIELD =
  'w-full rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 text-sm read-only:opacity-60 focus:border-[var(--accent)] focus:outline-none';

/** The column a list shows: a stack's id, or the board's archived cards. */
type Column = number | 'archived';

/** A due date as a row's short age: "due in 3d", "due 2w ago"; an unreadable one shows nothing. */
function dueLabel(iso: string | null): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const now = Date.now();
  const span = at >= now ? formatAge(now, at) : formatAge(at, now);
  if (span === 'now') return 'due now';
  return at >= now ? `due in ${span}` : `due ${span} ago`;
}

/** A due date as the opened card shows it: the local date. */
function dueDate(iso: string | null): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '' : new Date(at).toLocaleDateString();
}

/** A due date as a `type="date"` input's value (the local day), or '' for none. */
function toDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A date input's value as the ISO time sent to Deck (local midnight); empty means no due date. */
function fromDateInput(value: string): string | null {
  return value === '' ? null : new Date(`${value}T00:00:00`).toISOString();
}

/**
 * The column to show: the owner's remembered one while it's still on the
 * board, else the "Doing" column, else the first (spec 2026-10-22-nextcloud-tabs,
 * "Calls I made").
 */
function shownColumn(board: DeckBoardView, remembered: DeckView['stackId']): Column | null {
  if (remembered === 'archived') return 'archived';
  if (remembered !== null && board.stacks.some((s) => s.id === remembered)) return remembered;
  return board.doingStackId ?? board.stacks[0]?.id ?? null;
}

function LabelPills({ labels }: { labels: DeckLabel[] }): JSX.Element | null {
  if (labels.length === 0) return null;
  return (
    <span className="mt-0.5 flex flex-wrap gap-1">
      {labels.map((l) => (
        <span key={l.id} className="rounded-full border border-[var(--border)] px-1.5 text-[0.65rem] text-[var(--text-muted)]">
          {l.title}
        </span>
      ))}
    </span>
  );
}

/**
 * The Code panel's Deck tab (spec 2026-10-22-nextcloud-tabs, Goals 1-3,
 * mockup B): the app's Deck board one column at a time, with a button per
 * column and one for the archived cards. A click opens a card, where it can
 * be edited, moved, completed, labelled, archived, deleted or have a chat
 * started on it. Each action is followed by fetching the card and the board
 * again.
 *
 * Where it is (the column shown, the card open) belongs to its `owner`, a
 * chat or an app home, and is kept in the store (`deckViews`), as the Issues
 * tab keeps its own. Nextcloud's last answers are kept there too, and shown
 * while they're fetched again.
 */
export function DeckTab({ app, owner }: { app: App; owner: string }): JSX.Element {
  const view = useOtherBenchStore((s) => s.deckViews[owner]);
  const setDeckView = useOtherBenchStore((s) => s.setDeckView);
  const cached = useOtherBenchStore((s) => s.deckBoards[app.id] ?? null);
  const cacheDeckBoard = useOtherBenchStore((s) => s.cacheDeckBoard);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const boardId = app.deckBoardId;
  // A board cached before the app was pointed at another one isn't shown.
  const board = cached && cached.board.id === boardId ? cached : null;
  const refresh = (): void => setReload((n) => n + 1);

  // On focus and after a turn in one of the app's chats, as well as from ↻.
  useCodeRefresh(app.id, refresh);
  useEffect(() => setError(null), [app.id, boardId]);
  useEffect(() => {
    // Nothing to ask for: the server would only answer no-deck-board.
    if (boardId === null) return;
    let cancelled = false;
    api.apps.deck.board(app.id).then(
      (r) => {
        if (cancelled) return;
        cacheDeckBoard(app.id, r);
        setError(null);
      },
      (err: unknown) => !cancelled && setError(err)
    );
    return () => {
      cancelled = true;
    };
  }, [app.id, boardId, reload, cacheDeckBoard]);

  const selected = view?.selected ?? null;
  return (
    <div data-testid="deck-tab" className="min-w-0">
      {boardId === null ? (
        <div role="alert" className="text-sm text-[var(--text-muted)]">
          <p>{NO_DECK_BOARD}</p>
        </div>
      ) : selected === null ? (
        <DeckList
          app={app}
          board={board}
          error={error}
          column={board ? shownColumn(board, view?.stackId ?? null) : null}
          onColumn={(c) => setDeckView(owner, { stackId: c })}
          onOpen={(id) => setDeckView(owner, { selected: id })}
          onRefresh={refresh}
        />
      ) : (
        <CardView app={app} cardId={selected} board={board} onBack={() => setDeckView(owner, { selected: null })} onBoardChanged={refresh} />
      )}
    </div>
  );
}

function DeckList({
  app,
  board,
  error,
  column,
  onColumn,
  onOpen,
  onRefresh,
}: {
  app: App;
  board: DeckBoardView | null;
  error: unknown;
  column: Column | null;
  onColumn: (c: Column) => void;
  onOpen: (id: number) => void;
  onRefresh: () => void;
}): JSX.Element {
  const cacheDeckCard = useOtherBenchStore((s) => s.cacheDeckCard);
  const [starting, setStarting] = useState<number | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  // A row's Chat button: the card's description is fetched, as the board carries only its title, then the chat starts as from the card itself.
  async function startOn(id: number): Promise<void> {
    if (starting !== null) return;
    setStarting(id);
    setStartError(null);
    try {
      await startChatFromCard(app, await api.nextcloud.card(id, app.deckBoardId));
    } catch (err) {
      console.error(`[otherbench-web] failed to start a chat on Deck #${id}:`, err);
      setStartError(err);
    } finally {
      setStarting(null);
    }
  }

  // "+ Card": made in the column shown, then opened.
  async function create(): Promise<void> {
    const title = newTitle.trim();
    if (creating || title === '' || typeof column !== 'number') return;
    setCreating(true);
    setCreateError(null);
    try {
      const description = newDescription.trim() === '' ? {} : { description: newDescription };
      const card = await api.apps.deck.create(app.id, { stackId: column, title, ...description });
      cacheDeckCard(card);
      setAdding(false);
      setNewTitle('');
      setNewDescription('');
      onRefresh();
      onOpen(card.id);
    } catch (err) {
      console.error('[otherbench-web] failed to add a Deck card:', err);
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  const cards: DeckCardSummary[] = !board || column === null ? [] : column === 'archived' ? board.archived : (board.stacks.find((s) => s.id === column)?.cards ?? []);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className={`min-w-0 flex-1 truncate ${MUTED}`}>{board?.board.title ?? ''}</p>
        <button
          type="button"
          aria-expanded={adding}
          disabled={typeof column !== 'number'}
          onClick={() => setAdding((a) => !a)}
          className="btn shrink-0 px-1.5 py-0 text-xs disabled:opacity-50"
        >
          + Card
        </button>
        <button
          type="button"
          aria-label="Refresh the board"
          title="Refresh the board"
          onClick={onRefresh}
          className="shrink-0 rounded px-1 text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
        >
          <span aria-hidden="true">↻</span>
        </button>
      </div>
      {board && (
        <div role="group" aria-label="Deck columns" className="flex flex-wrap gap-1 text-xs">
          {[...board.stacks.map((s) => ({ key: s.id as Column, title: s.title, count: s.cards.length })), { key: 'archived' as Column, title: 'Archived', count: board.archived.length }].map(
            (c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={column === c.key}
                onClick={() => onColumn(c.key)}
                className={`rounded border border-[var(--border)] px-2 py-0.5 ${column === c.key ? 'bg-[var(--bg-sunken)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}
              >
                {c.title} <span className="tabular-nums text-[var(--text-faint)]">{c.count}</span>
              </button>
            )
          )}
        </div>
      )}
      {adding && typeof column === 'number' && (
        <form
          aria-label="New card"
          className="space-y-1.5 rounded-sm border border-[var(--border)] p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input aria-label="New card title" placeholder="Title" value={newTitle} readOnly={creating} onChange={(e) => setNewTitle(e.target.value)} className={FIELD} />
          <textarea
            aria-label="New card description"
            placeholder="Description (optional)"
            value={newDescription}
            readOnly={creating}
            rows={3}
            onChange={(e) => setNewDescription(e.target.value)}
            className={`resize-y ${FIELD}`}
          />
          <div className="flex gap-2">
            <button type="submit" disabled={creating || newTitle.trim() === ''} className="btn btn-primary px-2.5 py-1">
              Add
            </button>
            <button type="button" disabled={creating} onClick={() => setAdding(false)} className="btn px-2.5 py-1">
              Cancel
            </button>
          </div>
          {createError !== null && <CodeErrorLine error={createError} fallback="Couldn't add the card." />}
        </form>
      )}
      {error !== null ? (
        <CodeErrorLine error={error} fallback="Couldn't load the board." />
      ) : !board ? (
        <p className={EMPTY}>Loading…</p>
      ) : cards.length === 0 ? (
        <p className={EMPTY}>{column === 'archived' ? 'No archived cards' : 'No cards in this column'}</p>
      ) : (
        <>
          {startError !== null && <CodeErrorLine error={startError} fallback="Couldn't start the chat." />}
          <ul aria-label="Cards" className="space-y-0.5">
            {cards.map((card) => (
              <li key={card.id} data-card={card.id} className="flex items-start rounded-sm hover:bg-[var(--bg-sunken)]">
                <button
                  type="button"
                  data-testid={`card-row-${card.id}`}
                  onClick={() => onOpen(card.id)}
                  className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1 text-left text-sm"
                >
                  <span className="shrink-0 tabular-nums text-[var(--text-faint)]">#{card.id}</span>
                  <span className="min-w-0 flex-1">
                    <span className="[overflow-wrap:anywhere]">{card.title}</span>
                    <LabelPills labels={card.labels} />
                  </span>
                  {card.done && (
                    <span aria-label="Done" className="shrink-0 text-xs text-[var(--text-muted)]">
                      ✓
                    </span>
                  )}
                  {dueLabel(card.duedate) && <span className="shrink-0 text-xs text-[var(--text-faint)]">{dueLabel(card.duedate)}</span>}
                </button>
                {/* Beside the row's button, not in it: a button can't hold another. */}
                <button
                  type="button"
                  aria-label={`Start a chat on #${card.id}`}
                  title="Start a chat on this card"
                  disabled={starting !== null}
                  onClick={() => void startOn(card.id)}
                  className="btn my-1 mr-1 shrink-0 px-1.5 py-0 text-xs disabled:opacity-50"
                >
                  {starting === card.id ? 'Starting…' : 'Chat'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CardView({
  app,
  cardId,
  board,
  onBack,
  onBoardChanged,
}: {
  app: App;
  cardId: number;
  board: DeckBoardView | null;
  onBack: () => void;
  onBoardChanged: () => void;
}): JSX.Element {
  // Nextcloud's last answer for the card, shown while it's fetched again.
  const card = useOtherBenchStore((s) => s.deckCards[cardId] ?? null);
  const cacheDeckCard = useOtherBenchStore((s) => s.cacheDeckCard);
  const forgetDeckCard = useOtherBenchStore((s) => s.forgetDeckCard);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ error: unknown; fallback: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The board to look on first: the card's own once it's known, so a card on another board isn't searched for across every board each time.
  const boardHint = card?.boardId ?? app.deckBoardId;
  // Read when a fetch starts rather than being a dependency, so learning the card's board doesn't fetch it again.
  const hintRef = useRef(boardHint);
  hintRef.current = boardHint;

  useCodeRefresh(app.id, () => setReload((n) => n + 1));
  useEffect(() => {
    let cancelled = false;
    api.nextcloud.card(cardId, hintRef.current).then(
      (r) => {
        if (cancelled) return;
        cacheDeckCard(r);
        setLoadError(null);
      },
      (err: unknown) => {
        if (cancelled) return;
        setLoadError(err);
        // Gone from Nextcloud (deleted elsewhere): stop showing it, and fetch the list it's no longer in.
        if (err instanceof ApiError && err.code === 'nextcloud-not-found') {
          forgetDeckCard(cardId);
          onBoardChanged();
        }
      }
    );
    return () => {
      cancelled = true;
    };
    // onBoardChanged is a fresh closure each render; only these say the card needs fetching again.
  }, [cardId, reload, cacheDeckCard, forgetDeckCard]);

  /**
   * One user action on the card; the card (unless it's gone) and the board are
   * fetched again after. A failed one fetches both again too: the card may
   * have changed or vanished elsewhere, and the list should say so.
   */
  async function act(kind: string, run: () => Promise<unknown>, refetchCard = true): Promise<boolean> {
    if (busy) return false;
    setBusy(kind);
    setActionError(null);
    try {
      await run();
      if (refetchCard) setReload((n) => n + 1);
      onBoardChanged();
      return true;
    } catch (err) {
      console.error(`[otherbench-web] Deck #${cardId} ${kind} failed:`, err);
      setActionError({ error: err, fallback: "Couldn't change the card." });
      setReload((n) => n + 1);
      onBoardChanged();
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function startChat(): Promise<void> {
    if (!card || busy) return;
    setBusy('chat');
    setActionError(null);
    try {
      await startChatFromCard(app, card);
    } catch (err) {
      console.error(`[otherbench-web] failed to start a chat on Deck #${cardId}:`, err);
      setActionError({ error: err, fallback: "Couldn't start the chat. Please try again." });
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    setConfirmDelete(false);
    if (await act('delete', () => api.nextcloud.deleteCard(cardId, boardHint), false)) {
      forgetDeckCard(cardId);
      onBack();
    }
  }

  const back = (
    <button type="button" onClick={onBack} aria-label="Back to the board" className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
      <span aria-hidden="true">← Deck</span>
    </button>
  );

  if (!card) {
    return (
      <div className="space-y-2">
        {back}
        {loadError !== null ? <CodeErrorLine error={loadError} fallback="Couldn't load the card." /> : <p className={EMPTY}>Loading…</p>}
      </div>
    );
  }

  // The board's columns and labels only fit a card on that board; one on another board can't be moved or labelled from here.
  const onShownBoard = board !== null && card.boardId === board.board.id;
  const due = dueDate(card.duedate);
  return (
    <div data-testid="card-detail" className="min-w-0 space-y-3">
      {/* A refresh that failed: the card below is Nextcloud's last answer. */}
      {loadError !== null && <CodeErrorLine error={loadError} fallback="Couldn't load the card." />}
      <div className="flex items-center gap-2">
        {back}
        <span className="flex-1" />
        <a
          href={card.url}
          onClick={(e) => {
            e.preventDefault();
            void openInBrowser(card.url);
          }}
          className="text-xs text-[var(--accent)] hover:underline"
        >
          Open in Nextcloud <span aria-hidden="true">↗</span>
        </a>
      </div>
      <div>
        <h3 className="text-sm font-medium [overflow-wrap:anywhere]">{`#${card.id} ${card.title}`}</h3>
        <p className={MUTED}>
          <span data-testid="card-column">{card.stackTitle}</span>
          {card.archived && ' · Archived'}
          {card.done && ' · ✓ Done'}
          {due && ` · Due ${due}`}
        </p>
        {card.boardId !== app.deckBoardId && <p className={MUTED}>{`On the ${card.boardTitle} board`}</p>}
        <LabelPills labels={card.labels} />
      </div>
      {editing ? (
        <EditForm card={card} busy={busy !== null} onCancel={() => setEditing(false)} onSave={(change) => act('edit', () => api.nextcloud.updateCard(cardId, change, boardHint))} onSaved={() => setEditing(false)} />
      ) : (
        <div onClick={stayInApp} className="min-w-0 [overflow-wrap:anywhere]">
          {card.description.trim() ? <MarkdownBody text={card.description} remoteImages={false} /> : <p className={EMPTY}>No description.</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy !== null} onClick={() => void startChat()} className="btn btn-primary px-2.5 py-1">
          Start a chat on this
        </button>
        {!editing && (
          <button type="button" disabled={busy !== null} onClick={() => setEditing(true)} className="btn px-2.5 py-1">
            Edit
          </button>
        )}
        {onShownBoard && (
          <label className={`flex items-center gap-1 ${MUTED}`}>
            Move to
            <select
              value={card.stackId}
              disabled={busy !== null}
              onChange={(e) => {
                const stackId = Number(e.target.value);
                if (stackId !== card.stackId) void act('move', () => api.nextcloud.moveCard(cardId, stackId, boardHint));
              }}
              className="rounded border border-[var(--border-strong)] bg-[var(--bg)] px-1 py-0.5 text-xs text-[var(--text)]"
            >
              {board.stacks.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {card.archived ? (
          <button type="button" disabled={busy !== null} onClick={() => void act('reopen', () => api.nextcloud.cardAction(cardId, 'reopen', boardHint))} className="btn px-2.5 py-1">
            Reopen
          </button>
        ) : (
          <>
            <button type="button" disabled={busy !== null} onClick={() => void act('done', () => api.nextcloud.cardAction(cardId, 'done', boardHint))} className="btn px-2.5 py-1">
              Done
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void act('archive', () => api.nextcloud.cardAction(cardId, 'archive', boardHint))} className="btn px-2.5 py-1">
              Archive
            </button>
          </>
        )}
        {onShownBoard && (
          <button type="button" aria-expanded={showLabels} onClick={() => setShowLabels((s) => !s)} className="btn px-2.5 py-1">
            Labels
          </button>
        )}
        <button type="button" disabled={busy !== null} onClick={() => setConfirmDelete(true)} className="btn btn-danger px-2.5 py-1">
          Delete
        </button>
      </div>
      {onShownBoard && showLabels && (
        <fieldset className="space-y-1 rounded-sm border border-[var(--border)] p-2">
          <legend className={`px-1 ${MUTED}`}>Labels</legend>
          {board.labels.length === 0 ? (
            <p className={EMPTY}>This board has no labels.</p>
          ) : (
            board.labels.map((l) => {
              const on = card.labels.some((c) => c.id === l.id);
              return (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy !== null}
                    onChange={() => void act('labels', () => api.nextcloud.labels(cardId, on ? { remove: [l.id] } : { add: [l.id] }, boardHint))}
                  />
                  {l.title}
                </label>
              );
            })
          )}
        </fieldset>
      )}
      {actionError !== null && <CodeErrorLine error={actionError.error} fallback={actionError.fallback} />}
      {confirmDelete && <ConfirmDialog title={`Delete card #${card.id}?`} confirmLabel="Delete" onConfirm={remove} onCancel={() => setConfirmDelete(false)} />}
    </div>
  );
}

/** The opened card's Edit form: its title (without the "#N " prefix, which the server keeps), description and due date. Only what changed is sent. */
function EditForm({
  card,
  busy,
  onSave,
  onSaved,
  onCancel,
}: {
  card: DeckCardDetail;
  busy: boolean;
  onSave: (change: { title?: string; description?: string; duedate?: string | null }) => Promise<boolean>;
  onSaved: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [due, setDue] = useState(toDateInput(card.duedate));

  async function save(): Promise<void> {
    const change: { title?: string; description?: string; duedate?: string | null } = {};
    if (title.trim() !== card.title) change.title = title.trim();
    if (description !== card.description) change.description = description;
    if (due !== toDateInput(card.duedate)) change.duedate = fromDateInput(due);
    if (Object.keys(change).length === 0 || (await onSave(change))) onSaved();
  }

  return (
    <form
      aria-label="Edit card"
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input aria-label="Title" value={title} readOnly={busy} onChange={(e) => setTitle(e.target.value)} className={FIELD} />
      <textarea aria-label="Description" value={description} readOnly={busy} rows={6} onChange={(e) => setDescription(e.target.value)} className={`resize-y ${FIELD}`} />
      <label className={`flex items-center gap-2 ${MUTED}`}>
        Due date
        <input type="date" value={due} readOnly={busy} onChange={(e) => setDue(e.target.value)} className="rounded border border-[var(--border-strong)] bg-[var(--bg)] px-1 py-0.5 text-xs text-[var(--text)]" />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || title.trim() === ''} className="btn btn-primary px-2.5 py-1">
          Save
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="btn px-2.5 py-1">
          Cancel
        </button>
      </div>
    </form>
  );
}
