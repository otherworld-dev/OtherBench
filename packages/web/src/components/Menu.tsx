import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent } from 'react';

/** One entry of a {@link Menu}. Give `submenu` to make it open a nested menu instead of acting. */
export interface MenuItem {
  id: string;
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** Set (true or false) on every item of a pick-one list; true marks the current choice. Renders as `menuitemradio`. */
  checked?: boolean;
  submenu?: MenuItem[];
  danger?: boolean;
  /** Set one step in under the item above it: a sub-project under its parent. */
  indent?: boolean;
}

/**
 * `dismiss`: Esc, Tab or a scroll -- the caller puts focus back on whatever
 * opened the menu. `pointer`: a pointerdown outside -- the user clicked
 * something else, so the caller must not steal focus from it. `select`: an
 * item was chosen -- its action decides where focus goes next (a rename
 * field, a dialog, the row).
 */
export type MenuCloseReason = 'dismiss' | 'pointer' | 'select';

export interface MenuProps {
  /** Accessible name of the menu. */
  label: string;
  items: MenuItem[];
  /** Viewport coordinates of the menu's top-left corner; kept on screen. */
  position: { x: number; y: number };
  onClose: (reason: MenuCloseReason) => void;
}

const LIST_CLASS = 'min-w-44 rounded border border-[var(--border)] bg-[var(--bg-raised)] p-1 shadow-lg';
const ITEM_CLASS =
  'flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-sm outline-none hover:bg-[var(--bg-sunken)] focus:bg-[var(--bg-sunken)] disabled:opacity-40';

function enabledIndexes(items: MenuItem[]): number[] {
  return items.flatMap((item, i) => (item.disabled ? [] : [i]));
}

interface MenuListProps {
  label: string;
  items: MenuItem[];
  isSubmenu: boolean;
  onChoose: (item: MenuItem) => void;
  /** Esc (and, in a submenu, ArrowLeft): leave this level. */
  onBack: () => void;
  onTab: () => void;
  className?: string;
  style?: CSSProperties;
}

function MenuList({ label, items, isSubmenu, onChoose, onBack, onTab, className, style }: MenuListProps): JSX.Element {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const [flipLeft, setFlipLeft] = useState(false);
  const [shiftY, setShiftY] = useState(0);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // A submenu measures itself once: flip to the left if it would overflow the
  // right edge, and shift up if it would overflow the bottom.
  useLayoutEffect(() => {
    if (!isSubmenu) return;
    const rect = listRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.right > window.innerWidth) setFlipLeft(true);
    if (rect.bottom > window.innerHeight) setShiftY(Math.max(-rect.top, window.innerHeight - rect.bottom));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measure once, when this level opens.
  }, []);

  // On open, focus the current choice of a pick-one list, else the first enabled item.
  useEffect(() => {
    const current = items.findIndex((item) => item.checked === true && !item.disabled);
    const start = current !== -1 ? current : enabledIndexes(items)[0];
    if (start !== undefined) refs.current[start]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once, when this level opens.
  }, []);

  function focusAt(i: number | undefined): void {
    if (i !== undefined) refs.current[i]?.focus();
  }

  function step(from: number, dir: 1 | -1): void {
    const enabled = enabledIndexes(items);
    if (enabled.length === 0) return;
    const pos = Math.max(enabled.indexOf(from), 0);
    focusAt(enabled[(pos + dir + enabled.length) % enabled.length]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number): void {
    const item = items[i];
    if (!item) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(i, 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        step(i, -1);
        return;
      case 'Home':
        e.preventDefault();
        focusAt(enabledIndexes(items)[0]);
        return;
      case 'End':
        e.preventDefault();
        focusAt(enabledIndexes(items).at(-1));
        return;
      case 'ArrowRight':
        if (item.submenu) {
          e.preventDefault();
          setOpenIndex(i);
        }
        return;
      case 'ArrowLeft':
        if (isSubmenu) {
          e.preventDefault();
          e.stopPropagation();
          onBack();
        }
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onBack();
        return;
      case 'Tab':
        e.preventDefault();
        onTab();
        return;
    }
  }

  return (
    <div
      ref={listRef}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      className={`${LIST_CLASS} ${className ?? ''} ${isSubmenu ? (flipLeft ? 'right-full mr-1' : 'left-full ml-1') : ''}`}
      style={isSubmenu ? { ...style, top: shiftY, maxHeight: Math.max(96, window.innerHeight - 8) } : style}
    >
      {items.map((item, i) => (
        <div key={item.id} role="none" className="relative">
          <button
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? openIndex === i : undefined}
            disabled={item.disabled}
            tabIndex={-1}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={() => {
              if (item.submenu) setOpenIndex(openIndex === i ? null : i);
              else onChoose(item);
            }}
            className={`${ITEM_CLASS} ${item.danger ? 'text-[var(--danger)]' : ''}`}
          >
            <span className={`truncate${item.indent ? ' pl-3' : ''}`}>{item.label}</span>
            {item.checked && <span aria-hidden="true">✓</span>}
            {item.submenu && <span aria-hidden="true">▸</span>}
          </button>
          {item.submenu && openIndex === i && (
            <MenuList
              label={item.label}
              items={item.submenu}
              isSubmenu
              onChoose={onChoose}
              onBack={() => {
                setOpenIndex(null);
                focusAt(i);
              }}
              onTab={onTab}
              className="absolute max-h-72 overflow-y-auto"
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A small accessible popup menu with one level of submenus (spec
 * 2026-10-03-projects-design §3 "Chat context menu"), shared by the chat row
 * menu and the project heading menu. Arrow keys, Home and End move between
 * enabled items; Enter/Space choose; ArrowRight/ArrowLeft open and close a
 * submenu; Esc, Tab, a pointerdown outside or any scroll dismiss it.
 */
export function Menu({ label, items, position, onClose }: MenuProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [placed, setPlaced] = useState(position);

  // Keep the whole menu on screen (a right-click near the bottom-right edge),
  // now and whenever the window is resized.
  useLayoutEffect(() => {
    const clamp = (): void => {
      const rect = rootRef.current?.getBoundingClientRect();
      setPlaced({
        x: Math.max(0, Math.min(position.x, window.innerWidth - (rect?.width ?? 0))),
        y: Math.max(0, Math.min(position.y, window.innerHeight - (rect?.height ?? 0))),
      });
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [position.x, position.y]);

  useEffect(() => {
    const outside = (reason: MenuCloseReason) => (e: Event): void => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) onCloseRef.current(reason);
    };
    const onPointerDown = outside('pointer');
    const onScroll = outside('dismiss');
    // Scrolling inside the menu (a long submenu, or focus() scrolling an item
    // into view) must not close it; only scrolling something else does.
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true); // capture: catches the sidebar's own scrolling too
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  return (
    <div ref={rootRef} className="fixed z-50 w-max" style={{ left: placed.x, top: placed.y }}>
      <MenuList
        label={label}
        items={items}
        isSubmenu={false}
        onChoose={(item) => {
          onCloseRef.current('select');
          item.onSelect?.();
        }}
        onBack={() => onCloseRef.current('dismiss')}
        onTab={() => onCloseRef.current('dismiss')}
      />
    </div>
  );
}
