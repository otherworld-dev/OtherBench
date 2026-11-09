import type { DragEvent, JSX, KeyboardEvent, MouseEvent } from 'react';
import { APP_NAME_MAX } from '@otherbench/core/domain/apps.js';
import { InlineNameInput } from '../components/InlineNameInput.js';
import { StatusWord } from '../components/StatusWord.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { isContextMenuKey, positionIn, type DropPosition, type MenuSource } from '../panes/sidebar/ChatRow.js';
import { PROJECT_DRAG_MIME, type ProjectReorder } from '../panes/sidebar/ProjectGroup.js';
import { chatStatus, type ChatActivity, type ChatStatus } from '../state/chatStatus.js';
import type { AllAppsCard } from './allAppsModel.js';

export type AllAppsLayout = 'grid' | 'list';

const PATH = 'truncate font-mono text-[11px] text-[var(--text-faint)]';
const NOT_HERE = 'Not on this machine';

/** A drag on the page carries `PROJECT_DRAG_MIME`, as the sidebar's heading drags did. */
export function carriesPageDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes(PROJECT_DRAG_MIME);
}

/** A ⋯ menu: the button toggles it; a right-click or Shift+F10 on the card or heading opens it too. */
export interface MenuControl {
  open: boolean;
  onOpen: (position: { x: number; y: number }, source: MenuSource) => void;
}

/** Renaming in place: the name becomes a field. */
export interface RenameControl {
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/** The ⋯ button of a card or a section heading, as on a sidebar heading. It never reaches the card under it. */
export function MenuButton({ label, menu }: { label: string; menu: MenuControl }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={menu.open}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        menu.onOpen({ x: r.left, y: r.bottom }, 'button');
      }}
      className="shrink-0 rounded px-1.5 py-0.5 text-sm leading-none text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
    >
      ⋯
    </button>
  );
}

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

/** "2 chats"; nothing with none, since the card already says "No chats yet". */
function chatCountText(n: number): string {
  return n === 0 ? '' : `${n} chat${n === 1 ? '' : 's'}`;
}

/** Which half of a card a dragged app is over: left/right across the grid's rows of cards, top/bottom down the list. */
function positionAcross(e: DragEvent<HTMLElement>, layout: AllAppsLayout): DropPosition {
  if (layout === 'list') return positionIn(e);
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left + r.width / 2 ? 'before' : 'after';
}

/** The drop line: the sidebar's inset accent line, on the side the app would land. */
function indicatorClass(indicator: DropPosition | null, layout: AllAppsLayout): string {
  if (indicator === null) return '';
  if (layout === 'list') return indicator === 'before' ? 'shadow-[inset_0_2px_0_var(--accent)]' : 'shadow-[inset_0_-2px_0_var(--accent)]';
  return indicator === 'before' ? 'shadow-[inset_2px_0_0_var(--accent)]' : 'shadow-[inset_-2px_0_0_var(--accent)]';
}

interface CardProps {
  card: AllAppsCard;
  layout: AllAppsLayout;
  activity: ChatActivity;
  now: number;
  onOpen: () => void;
  menu?: MenuControl;
  /** Set while the app's name is being edited. */
  rename?: RenameControl | null;
  /** Drag the card to reorder it in its section, or onto another section's card to file it there at that place. */
  reorder?: ProjectReorder;
}

/**
 * One app on the All apps page: a card in the grid, a row in the list. A click anywhere on it opens the app; for the
 * keyboard and screen readers the app's name is the button that does, with the ⋯ button beside it rather than inside
 * it (axe nested-interactive).
 */
export function AllAppsCardView({ card, layout, activity, now, onOpen, menu, rename, reorder }: CardProps): JSX.Element {
  const { app } = card;
  const onKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!menu || !isContextMenuKey(e)) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    menu.onOpen({ x: r.left + 16, y: r.bottom }, 'context');
  };
  const used = card.lastUsed === null ? 'No chats yet' : formatRelativeTime(card.lastUsed, now);
  const draggable = !rename && reorder?.draggable === true;
  const common = {
    'data-testid': `all-apps-card-${app.id}`,
    'data-open': app.open ? 'true' : undefined,
    'data-drop-position': reorder?.indicator ?? undefined,
    onClick: rename ? undefined : onOpen,
    onContextMenu: menu
      ? (e: MouseEvent<HTMLDivElement>) => {
          e.preventDefault();
          menu.onOpen({ x: e.clientX, y: e.clientY }, 'context');
        }
      : undefined,
    draggable,
    onDragStart: draggable
      ? (e: DragEvent<HTMLDivElement>) => {
          e.dataTransfer.setData(PROJECT_DRAG_MIME, app.id);
          e.dataTransfer.effectAllowed = 'move';
          reorder?.onDragStart();
        }
      : undefined,
    onDragEnd: reorder ? () => reorder.onDragEnd() : undefined,
    // A card takes another app (placed before or after it); anything else goes on to its section.
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!reorder?.target || !carriesPageDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const position = positionAcross(e, layout);
      if (position !== reorder.indicator) reorder.onOver(position);
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      reorder?.onLeave();
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      if (!reorder?.target || !carriesPageDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      reorder.onDrop(positionAcross(e, layout));
    },
  };
  // The field sits inside the card: its clicks must not open the app.
  // The name button's click goes on up to the card, which opens the app.
  const name = (className: string): JSX.Element =>
    rename ? (
      <span className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
        <InlineNameInput initial={app.name} label="App name" maxLength={APP_NAME_MAX} onCommit={rename.onCommit} onCancel={rename.onCancel} />
      </span>
    ) : (
      <button type="button" data-card-main="" onKeyDown={onKey} className={`min-w-0 truncate text-left ${className}`}>
        {app.name}
      </button>
    );
  const menuButton = menu ? <MenuButton label={`Actions for ${app.name}`} menu={menu} /> : null;
  const line = indicatorClass(reorder?.indicator ?? null, layout);
  if (layout === 'list') {
    return (
      <div
        {...common}
        className={`grid cursor-pointer grid-cols-[1.5rem_minmax(0,1.2fr)_minmax(0,1.6fr)_auto_auto_8rem] items-center gap-3 border-t border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-sm first:border-t-0 hover:bg-[var(--bg-sunken)] ${line}`}
      >
        <Tile name={app.name} />
        <span className="flex min-w-0 items-baseline gap-2">
          {name('font-medium')}
          {app.open && <span className="shrink-0 text-[11px] text-[var(--accent)]">In sidebar</span>}
        </span>
        <span className={PATH}>{app.workspaceRoot ?? NOT_HERE}</span>
        <span className="text-xs text-[var(--text-muted)]">{chatCountText(card.chatCount)}</span>
        <span className="flex items-baseline gap-2">
          <StatusWords card={card} activity={activity} now={now} />
        </span>
        <span className="flex items-center justify-end gap-2 text-xs text-[var(--text-faint)]">
          {used}
          {menuButton}
        </span>
      </div>
    );
  }
  return (
    <div
      {...common}
      className={`relative flex min-h-[6.5rem] cursor-pointer flex-col gap-1.5 rounded-lg border bg-[var(--bg-raised)] p-3 text-left hover:border-[var(--border-strong)] ${app.open ? 'border-[var(--accent)]' : 'border-[var(--border)]'} ${line}`}
    >
      <div className="flex items-center gap-2 pr-16">
        <Tile name={app.name} />
        {name('text-sm font-semibold')}
      </div>
      <div className="absolute right-2 top-2.5 flex items-center gap-1.5">
        {app.open && <span className="text-[10px] text-[var(--accent)]">In sidebar</span>}
        {menuButton}
      </div>
      <span className={PATH}>{app.workspaceRoot ?? NOT_HERE}</span>
      <div className="mt-auto flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-[var(--text-muted)]">
        {card.chatCount > 0 && <span>{chatCountText(card.chatCount)}</span>}
        <StatusWords card={card} activity={activity} now={now} />
        <span className="ml-auto text-[var(--text-faint)]">{used}</span>
      </div>
    </div>
  );
}
