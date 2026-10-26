import { useState, type JSX, type ReactNode } from 'react';
import type { OverviewChat, OverviewDueCard, OverviewIssue, OverviewTile as Tile } from '@otherbench/core/types/overview.js';
import { formatAge } from '../lib/relativeTime.js';
import { openApp, openCard, openChat, openIssue } from './openFromOverview.js';

/** Issues shown before "+N more". */
const ISSUES_SHOWN = 3;

/** The DOM id a tile carries, so the jump list can scroll to it. */
export const overviewTileDomId = (key: string): string => `overview-tile-${key}`;

const ROW = 'flex w-full items-baseline justify-between gap-2 border-t border-[var(--border)] py-0.5 text-left text-sm hover:bg-[var(--bg-sunken)]';
const MUTED = 'text-xs text-[var(--text-muted)]';

/** A section heading inside a tile: more prominent than `.label-caps`, with an accent underline. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section>
      <h3 className="font-label mt-3 mb-1 border-b-2 border-[var(--accent)]/40 pb-0.5 text-sm font-bold uppercase tracking-[0.08em] text-[var(--accent)]">{title}</h3>
      {children}
    </section>
  );
}

/** One chat needing you. Task 10 adds its tick-off action here. */
export function OverviewChatRow({ chat }: { chat: OverviewChat }): JSX.Element {
  return (
    <button
      type="button"
      data-testid={`overview-chat-${chat.chatId}`}
      onClick={(e) => {
        e.stopPropagation();
        openChat(chat.chatId);
      }}
      className={ROW}
    >
      <span className="truncate">{chat.title}</span>
      {chat.waiting && <span className={`${MUTED} shrink-0`}>waiting</span>}
    </button>
  );
}

/** One issue needing you. Task 10 adds its tick-off action here. */
export function OverviewIssueRow({ appId, issue }: { appId: string; issue: OverviewIssue }): JSX.Element {
  const age = formatAge(Date.parse(issue.at));
  return (
    <button
      type="button"
      data-testid={`overview-issue-${appId}-${issue.number}`}
      onClick={(e) => {
        e.stopPropagation();
        openIssue(appId, issue.number, issue.state);
      }}
      className={ROW}
    >
      <span className="min-w-0 truncate">
        {issue.state === 'closed' && <span className="mr-1 rounded-[3px] border border-[var(--border-strong)] px-1 text-[0.65rem] text-[var(--text-muted)]">closed</span>}
        #{issue.number} {issue.title}
      </span>
      <span className={`${MUTED} shrink-0 whitespace-nowrap`}>{issue.kind} · {age}</span>
    </button>
  );
}

/** One overdue or due-today Deck card. */
export function OverviewCardRow({ appId, card }: { appId: string; card: OverviewDueCard }): JSX.Element {
  return (
    <button
      type="button"
      data-testid={`overview-card-${card.cardId}`}
      onClick={(e) => {
        e.stopPropagation();
        openCard(appId, card.cardId);
      }}
      className={`${ROW} text-[var(--danger)]`}
    >
      <span className="min-w-0 truncate">{card.title}</span>
      <span className="shrink-0 whitespace-nowrap text-xs">{card.overdueDays > 0 ? `overdue ${card.overdueDays}d` : 'due today'}</span>
    </button>
  );
}

function ChatsSection({ chats }: { chats: OverviewChat[] }): JSX.Element {
  const groups = new Map<string, { name: string; chats: OverviewChat[] }>();
  for (const chat of chats) {
    const key = chat.projectId ?? '';
    const group = groups.get(key) ?? { name: chat.projectName ?? 'No project', chats: [] };
    group.chats.push(chat);
    groups.set(key, group);
  }
  return (
    <Section title="Chats">
      {[...groups.entries()].map(([key, group]) => (
        <div key={key}>
          <div className={`${MUTED} pt-1`}>{group.name}</div>
          {group.chats.map((chat) => (
            <OverviewChatRow key={chat.chatId} chat={chat} />
          ))}
        </div>
      ))}
    </Section>
  );
}

function IssuesSection({ tile, appId }: { tile: Tile; appId: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const issues = tile.issues ?? [];
  const shown = expanded ? issues : issues.slice(0, ISSUES_SHOWN);
  const hidden = issues.length - shown.length;
  return (
    <Section title="Issues needing you">
      {tile.issuesError !== null ? (
        <p className={MUTED}>{tile.issuesError}</p>
      ) : issues.length === 0 ? (
        <p className={MUTED}>None</p>
      ) : (
        <>
          {shown.map((issue) => (
            <OverviewIssueRow key={issue.number} appId={appId} issue={issue} />
          ))}
          {hidden > 0 && (
            <button
              type="button"
              data-testid={`overview-more-${tile.key}`}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
              className={`${MUTED} pt-0.5 hover:text-[var(--text)]`}
            >
              +{hidden} more
            </button>
          )}
        </>
      )}
    </Section>
  );
}

function DeckSection({ tile, appId }: { tile: Tile; appId: string }): JSX.Element {
  const deck = tile.deck;
  return (
    <Section title="Deck">
      {tile.deckError !== null ? (
        <p className={MUTED}>{tile.deckError}</p>
      ) : (
        deck && (
          <>
            {deck.due.map((card) => (
              <OverviewCardRow key={card.cardId} appId={appId} card={card} />
            ))}
            <p className="pt-1 text-xs text-[var(--text-muted)]">{`Doing ${deck.doing} · To Do ${deck.todo} · Backlog ${deck.backlog}`}</p>
          </>
        )
      )}
    </Section>
  );
}

/** One app's (or the loose chats') tile. Clicking its background opens the app; the rows inside stop the click. */
export function OverviewTile({ tile }: { tile: Tile }): JSX.Element {
  const appId = tile.appId;
  return (
    <div
      id={overviewTileDomId(tile.key)}
      data-testid={overviewTileDomId(tile.key)}
      onClick={appId === null ? undefined : () => openApp(appId)}
      className={`rounded-md border border-[var(--border-strong)] bg-[var(--bg-raised)] p-3 ${appId === null ? '' : 'cursor-pointer hover:border-[var(--accent)]'} ${tile.faded ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center justify-between gap-2 text-sm font-bold">
        <span className="truncate">{tile.name}</span>
        {tile.count > 0 && <span className="rounded-full bg-[var(--accent)] px-1.5 text-[0.65rem] tabular-nums text-[var(--bg)]">{tile.count}</span>}
      </div>
      {tile.chats.length > 0 && <ChatsSection chats={tile.chats} />}
      {appId !== null && tile.issues !== null && <IssuesSection tile={tile} appId={appId} />}
      {appId !== null && tile.deck !== null && <DeckSection tile={tile} appId={appId} />}
      {tile.faded && <p className={`${MUTED} pt-1`}>Nothing needs you</p>}
    </div>
  );
}
