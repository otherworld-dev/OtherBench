import { useState, type JSX } from 'react';
import { appNotesSections, notesContainFact, splitNoteOffers } from '@otherbench/core/domain/app-notes.js';
import { ApiError, api } from '../state/api.js';
import { useAppNotes, useAppNotesStore, type FactCard } from '../state/appNotes.js';
import { useOtherBenchStore } from '../state/store.js';
import { MarkdownBody } from './MarkdownBody.js';

// The cards app notes put in a chat (spec 2026-11-05-app-notes-design, "Adding
// a fact mid-chat"): the confirmation for a fact typed with `#`, and a model's
// offer of one, which is saved only when the user presses Save.

const CARD = 'my-2 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-sm';
const DASHED = 'my-2 rounded border border-dashed border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 py-2 text-sm';
const LABEL = 'label-caps text-[var(--text-muted)]';
const BUTTON = 'btn px-2 py-0.5 text-xs';
const FIELD = 'w-full rounded border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1 text-sm focus:border-[var(--accent)] focus:outline-none';

const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError ? err.message : fallback);
/** A note line as shown: without its bullet. */
const shown = (line: string): string => line.replace(/^[-*+]\s+/, '');

/** The facts typed with `#` in this chat since the window opened, newest last. */
export function FactCards({ chatId }: { chatId: string }): JSX.Element | null {
  const cards = useAppNotesStore((s) => s.cards[chatId]);
  if (!cards || cards.length === 0) return null;
  return (
    <div data-testid="fact-cards">
      {cards.map((card) => (
        <FactCardView key={card.id} chatId={chatId} card={card} />
      ))}
    </div>
  );
}

function FactCardView({ chatId, card }: { chatId: string; card: FactCard }): JSX.Element {
  const { view } = useAppNotes(card.appId);
  const setView = useAppNotesStore((s) => s.setView);
  const updateCard = useAppNotesStore((s) => s.updateCard);
  const dismiss = useAppNotesStore((s) => s.dismissCard);
  const appName = useOtherBenchStore((s) => s.apps.find((a) => a.id === card.appId)?.name ?? 'the app');
  const [mode, setMode] = useState<'view' | 'edit' | 'move'>('view');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { fact } = card;

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode('view');
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const edit = (): Promise<void> =>
    run(async () => {
      setView(card.appId, await api.appNotes.editFact(card.appId, fact.line, draft));
      updateCard(chatId, card.id, { fact: { ...fact, line: `- ${draft.replace(/\s+/g, ' ').trim()}` } });
    }, "Couldn't change it.");
  const move = (section: string): Promise<void> =>
    run(async () => {
      setView(card.appId, await api.appNotes.moveFact(card.appId, fact.line, section));
      updateCard(chatId, card.id, { fact: { ...fact, section } });
    }, "Couldn't move it.");
  const undo = (): Promise<void> =>
    run(async () => {
      setView(card.appId, await api.appNotes.undoFact(card.appId, fact));
      updateCard(chatId, card.id, { state: 'undone' });
    }, "Couldn't take it back.");

  if (card.state === 'undone') {
    return (
      <div data-testid="fact-card" className={`${CARD} flex items-center gap-2 text-[var(--text-muted)]`}>
        <span className="min-w-0 flex-1">Taken back out of {appName}&apos;s notes.</span>
        <button type="button" onClick={() => dismiss(chatId, card.id)} className={BUTTON}>
          Dismiss
        </button>
      </div>
    );
  }

  if (!fact.added) {
    return (
      <div data-testid="fact-card" className={`${CARD} flex items-center gap-2`}>
        <span className="min-w-0 flex-1">
          <span className="text-[var(--text-muted)]">Already in {appName}&apos;s notes · {fact.section}:</span> {shown(fact.line)}
        </span>
        <button type="button" onClick={() => dismiss(chatId, card.id)} className={BUTTON}>
          Dismiss
        </button>
      </div>
    );
  }

  const sections = view ? appNotesSections(view.notes.body).filter((s) => s !== fact.section) : [];
  return (
    <div data-testid="fact-card" className={CARD}>
      <div className="flex items-center gap-2">
        <p className={`${LABEL} min-w-0 flex-1`}>
          Saved to {appName}&apos;s notes · {fact.section}
        </p>
        <button type="button" aria-label="Dismiss" onClick={() => dismiss(chatId, card.id)} className="text-[var(--text-muted)] hover:text-[var(--text)]">
          ✕
        </button>
      </div>
      {mode === 'edit' ? (
        <div className="mt-1 space-y-1.5">
          <input aria-label="Fact" value={draft} onChange={(e) => setDraft(e.target.value)} className={FIELD} />
          <div className="flex gap-2">
            <button type="button" disabled={busy || draft.trim() === ''} onClick={() => void edit()} className={`${BUTTON} btn-primary`}>
              Save
            </button>
            <button type="button" onClick={() => setMode('view')} className={BUTTON}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1">{shown(fact.line)}</p>
      )}
      {fact.replaced && <p className="mt-1 text-xs text-[var(--text-muted)]">Replaced: <s>{shown(fact.replaced)}</s></p>}
      {mode === 'move' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-[var(--text-muted)]">Move to</span>
          {sections.map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => void move(s)} className={BUTTON}>
              {s}
            </button>
          ))}
          <button type="button" onClick={() => setMode('view')} className={BUTTON}>
            Cancel
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-[var(--danger)]">{error}</p>}
      {mode === 'view' && (
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(shown(fact.line));
              setMode('edit');
            }}
            className={BUTTON}
          >
            Edit
          </button>
          <button type="button" disabled={busy || sections.length === 0} onClick={() => setMode('move')} className={BUTTON}>
            Move
          </button>
          <button type="button" disabled={busy} onClick={() => void undo()} className={BUTTON}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

/** A reply's text with each `<save-note>` offer shown as a card, for an app chat; elsewhere the offers show as plain lines. */
export function TextWithNoteOffers({ text, chatId }: { text: string; chatId: string }): JSX.Element {
  const appId = useOtherBenchStore((s) => s.chats.find((c) => c.id === chatId)?.appId ?? null);
  return (
    <>
      {splitNoteOffers(text).map((seg, i) =>
        seg.type === 'text' ? (
          <MarkdownBody key={i} text={seg.text} deckLinks copySections />
        ) : appId ? (
          <NoteOffer key={i} appId={appId} chatId={chatId} section={seg.section} fact={seg.fact} />
        ) : (
          <p key={i} className="my-2 border-l-2 border-[var(--border-strong)] pl-2 text-sm">
            {seg.fact}
          </p>
        )
      )}
    </>
  );
}

function NoteOffer({ appId, chatId, section, fact }: { appId: string; chatId: string; section: string; fact: string }): JSX.Element | null {
  const { view } = useAppNotes(appId);
  const setView = useAppNotesStore((s) => s.setView);
  const [state, setState] = useState<'offered' | 'editing' | 'declined'>('offered');
  const [draft, setDraft] = useState(fact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAs, setSavedAs] = useState<{ section: string; line: string } | null>(null);

  if (state === 'declined') return null;
  const already = savedAs !== null || (view !== null && notesContainFact(view.notes.body, fact));

  async function save(text: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.appNotes.addFact(appId, { text, section: section || null, chatId });
      setView(appId, saved);
      setSavedAs({ section: saved.fact.section, line: saved.fact.line });
      setState('offered');
    } catch (err) {
      setError(errorText(err, "Couldn't save it."));
    } finally {
      setBusy(false);
    }
  }

  if (already) {
    return (
      <div data-testid="note-offer" className={`${CARD} text-[var(--text-muted)]`}>
        <p className={LABEL}>Saved to notes{savedAs ? ` · ${savedAs.section}` : ''}</p>
        <p className="mt-1 text-[var(--text)]">{savedAs ? shown(savedAs.line) : fact}</p>
      </div>
    );
  }

  return (
    <div data-testid="note-offer" className={DASHED}>
      <p className={LABEL}>Save to notes?{section ? ` · ${section}` : ''}</p>
      {state === 'editing' ? (
        <input aria-label="Fact" value={draft} onChange={(e) => setDraft(e.target.value)} className={`${FIELD} mt-1`} />
      ) : (
        <p className="mt-1">{fact}</p>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-[var(--danger)]">{error}</p>}
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          disabled={busy || (state === 'editing' && draft.trim() === '')}
          onClick={() => void save(state === 'editing' ? draft : fact)}
          className={`${BUTTON} btn-primary`}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {state !== 'editing' && (
          <button type="button" disabled={busy} onClick={() => setState('editing')} className={BUTTON}>
            Edit first
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => setState('declined')} className={BUTTON}>
          No
        </button>
      </div>
    </div>
  );
}
