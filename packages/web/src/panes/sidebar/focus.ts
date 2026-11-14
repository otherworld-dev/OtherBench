/**
 * Focuses `selector` once React has committed (a moved row re-mounts under
 * its new group), unless focus has meanwhile gone into a menu, a dialog or a
 * text field -- another action took it on purpose.
 */
export function focusLater(selector: string, fallback?: string, options?: FocusOptions): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[role="menu"], [role="alertdialog"], input, select, textarea')) return;
    const target = document.querySelector<HTMLElement>(selector) ?? (fallback ? document.querySelector<HTMLElement>(fallback) : null);
    target?.focus(options);
  }, 0);
}

/** The chat list itself: the stable place focus falls back to when the row it wanted is gone. */
export const LIST_SELECTOR = '[data-chat-list]';

/**
 * Which of a chat's rows: the one in its group, or its copy under Pinned (a pinned chat stays in its group too, Deck
 * d961). Each has its own test id prefix, so a selector finds the one meant.
 */
export type RowKind = 'group' | 'pinned';

export const ROW_PREFIX: Record<RowKind, string> = { group: 'chat-row-', pinned: 'pinned-row-' };

export function rowSelector(chatId: string, kind: RowKind): string {
  return `[data-testid="${ROW_PREFIX[kind]}${chatId}"] [data-row-main]`;
}

export function headingSelector(projectId: string): string {
  return `[data-testid="group-heading-${projectId}"] [data-heading-main]`;
}

/** The heading to focus once `projectId`'s is gone: the next one, else the previous one. */
export function neighbourHeadingSelector(projectId: string): string {
  const heads = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="group-heading-"]'));
  const i = heads.findIndex((el) => el.getAttribute('data-testid') === `group-heading-${projectId}`);
  const neighbour = i === -1 ? undefined : (heads[i + 1] ?? heads[i - 1]);
  const key = neighbour?.getAttribute('data-testid')?.slice('group-heading-'.length);
  return key ? headingSelector(key) : LIST_SELECTOR;
}
