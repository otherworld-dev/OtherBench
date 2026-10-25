/**
 * Escape stops a chat's running reply, as Stop does, when nothing else used the key: a menu, dialog, rename or the
 * slash-command list calls `preventDefault`, and so does anything else that claims Escape. It only counts from the
 * message box (marked with this attribute) or from outside a text box, so Escape while editing a prompt or answering
 * a card never ends the reply by accident.
 */
export const ESCAPE_STOPS_REPLY_ATTR = 'data-escape-stops-reply';

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export function escapeStopsReply(e: { key: string; defaultPrevented: boolean; isComposing?: boolean; target: EventTarget | null }): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing === true) return false;
  const target = e.target instanceof Element ? e.target : null;
  if (target === null) return true;
  if (target.closest(`[${ESCAPE_STOPS_REPLY_ATTR}]`)) return true;
  return target.closest(EDITABLE) === null;
}
