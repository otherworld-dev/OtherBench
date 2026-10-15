import type { Locator, Page } from '@playwright/test';

/**
 * An Inspector section by title, opened if it was closed. Most sections start
 * closed; one whose body reports a problem opens itself, so only click a
 * header that is still collapsed.
 */
export async function openInspectorSection(page: Page, title: string): Promise<Locator> {
  const section = page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: title }).locator('xpath=ancestor::section[1]');
  const toggle = section.getByRole('button', { name: new RegExp(`^${title}`) });
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  return section;
}
