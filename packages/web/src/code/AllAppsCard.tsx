import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { StatusWord } from '../components/StatusWord.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { chatStatus, type ChatActivity, type ChatStatus } from '../state/chatStatus.js';
import type { AllAppsCard } from './allAppsModel.js';

export type AllAppsLayout = 'grid' | 'list';

const PATH = 'truncate font-mono text-[11px] text-[var(--text-faint)]';
const NOT_HERE = 'Not on this machine';

/** The first letter of the app's name on a neutral tile: no per-app colours. */
function Tile({ name }: { name: string }): JSX.Element {
  return (
    <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--bg-sunken)] text-xs font-bold text-[var(--text)]">
      {[...name][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

/** The distinct statuses among the app's chats, most urgent first (the order `StatusWord`s are declared in), each with its count. */
function StatusWords({ card, activity, now }: { card: AllAppsCard; activity: ChatActivity; now: number }): JSX.Element | null {
  const counts = new Map<ChatStatus, number>();
  for (const c of card.chats) {
    const s = chatStatus(c, activity, now);
    if (s !== null) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return (
    <>
      {[...counts].map(([status, n]) => (
        <span key={status} className="inline-flex items-baseline gap-1">
          {n > 1 && <span className="text-[11px] text-[var(--text-muted)]">{n}</span>}
          <StatusWord status={status} testId={`all-apps-status-${card.app.id}-${status}`} />
        </span>
      ))}
    </>
  );
}

function chatCountText(n: number): string {
  return `${n} chat${n === 1 ? '' : 's'}`;
}

interface CardProps {
  card: AllAppsCard;
  layout: AllAppsLayout;
  activity: ChatActivity;
  now: number;
  onOpen: () => void;
  /** Extra controls at the card's top right (the card menu); they must stop their own clicks from reaching the card. */
  actions?: ReactNode;
}

/**
 * One app on the All apps page: a card in the grid, a row in the list. The whole thing opens the app (a div with a
 * button role, so controls in `actions` can sit inside it).
 */
export function AllAppsCardView({ card, layout, activity, now, onOpen, actions }: CardProps): JSX.Element {
  const { app } = card;
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  const used = card.lastUsed === null ? 'No chats yet' : formatRelativeTime(card.lastUsed, now);
  const common = {
    role: 'button' as const,
    tabIndex: 0,
    'data-testid': `all-apps-card-${app.id}`,
    'data-open': app.open ? 'true' : undefined,
    onClick: onOpen,
    onKeyDown: onKey,
  };
  if (layout === 'list') {
    return (
      <div {...common} className="grid cursor-pointer grid-cols-[1.5rem_minmax(0,1.2fr)_minmax(0,1.6fr)_auto_auto_8rem] items-center gap-3 border-t border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-sm first:border-t-0 hover:bg-[var(--bg-sunken)]">
        <Tile name={app.name} />
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium">{app.name}</span>
          {app.open && <span className="shrink-0 text-[11px] text-[var(--accent)]">In sidebar</span>}
        </span>
        <span className={PATH}>{app.workspaceRoot ?? NOT_HERE}</span>
        <span className="text-xs text-[var(--text-muted)]">{chatCountText(card.chatCount)}</span>
        <span className="flex items-baseline gap-2">
          <StatusWords card={card} activity={activity} now={now} />
        </span>
        <span className="flex items-center justify-end gap-2 text-xs text-[var(--text-faint)]">
          {used}
          {actions}
        </span>
      </div>
    );
  }
  return (
    <div
      {...common}
      className={`relative flex min-h-[6.5rem] cursor-pointer flex-col gap-1.5 rounded-lg border bg-[var(--bg-raised)] p-3 text-left hover:border-[var(--border-strong)] ${app.open ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}
    >
      <div className="flex items-center gap-2 pr-16">
        <Tile name={app.name} />
        <span className="truncate text-sm font-semibold">{app.name}</span>
      </div>
      <div className="absolute right-2 top-2.5 flex items-center gap-1.5">
        {app.open && <span className="text-[10px] text-[var(--accent)]">In sidebar</span>}
        {actions}
      </div>
      <span className={PATH}>{app.workspaceRoot ?? NOT_HERE}</span>
      <div className="mt-auto flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-[var(--text-muted)]">
        <span>{chatCountText(card.chatCount)}</span>
        <StatusWords card={card} activity={activity} now={now} />
        <span className="ml-auto text-[var(--text-faint)]">{used}</span>
      </div>
    </div>
  );
}
