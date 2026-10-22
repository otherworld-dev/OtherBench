import { expect, type Page } from '@playwright/test';

/**
 * Selects a code panel tab by its id, from the strip or, when the panel is too
 * narrow to show it, from the More tabs menu. `label` is the tab's name as the
 * menu lists it.
 */
export async function openPanelTab(page: Page, id: string, label: string): Promise<void> {
  const panel = page.getByTestId('code-panel');
  const tab = panel.getByTestId(`code-panel-tab-${id}`);
  if (await tab.isVisible()) await tab.click();
  else {
    await panel.getByRole('button', { name: 'More tabs' }).click();
    await page.getByRole('menuitem', { name: label }).click();
  }
  await expect(panel.getByTestId(`code-panel-tab-${id}`)).toHaveAttribute('aria-selected', 'true');
}
