import type { MouseEvent } from 'react';

/**
 * Text from GitHub or Nextcloud comes as written, and Markdown can hold a
 * relative link (`../pull/5`). Outside a chat `MarkdownBody` leaves such a
 * link as a plain anchor, and following it would take the OtherBench window
 * itself away. Websites still open in the default browser through
 * `MarkdownBody`'s own handler (which runs first and prevents the default);
 * anything else is simply not followed. Put on the element wrapping the
 * rendered text, as its `onClick`.
 */
export function stayInApp(e: MouseEvent<HTMLElement>): void {
  const link = e.target instanceof Element ? e.target.closest('a') : null;
  if (!link || e.defaultPrevented) return;
  const href = link.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(href) || href.startsWith('#') || /^mailto:/i.test(href)) return;
  e.preventDefault();
}
