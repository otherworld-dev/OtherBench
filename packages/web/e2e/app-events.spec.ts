import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * The app-wide event stream (v2 plan, Task 34): a change made elsewhere (here
 * straight through the API, as another window or the tray would) reaches an
 * open page without a reload.
 */
test('a chat created, renamed and deleted elsewhere updates the open sidebar live', async ({ page, request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = (await (await request.post(`${BASE_URL}/api/profiles`, { data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard' } })).json()) as { id: string };

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Chats' });
  await expect(nav).toBeVisible();

  const title = `From elsewhere ${randomUUID().slice(0, 8)}`;
  const chat = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profile.id, title } })).json()) as { id: string };
  await expect(nav.getByTestId(`chat-row-${chat.id}`)).toContainText(title);

  await request.patch(`${BASE_URL}/api/chats/${chat.id}`, { data: { title: `${title} renamed` } });
  await expect(nav.getByTestId(`chat-row-${chat.id}`)).toContainText(`${title} renamed`);

  await request.delete(`${BASE_URL}/api/chats/${chat.id}`);
  await expect(nav.getByTestId(`chat-row-${chat.id}`)).toHaveCount(0);
});

test('an app made, renamed and deleted elsewhere updates the Move to app… menu of a window already open', async ({ page, request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = (await (await request.post(`${BASE_URL}/api/profiles`, { data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard' } })).json()) as { id: string };
  const suffix = randomUUID().slice(0, 8);
  const chat = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profile.id, title: `Chat to file ${suffix}` } })).json()) as { id: string };
  // At least one app from the start, so the menu item is there either side of the changes.
  const first = `Already here ${suffix}`;
  await request.post(`${BASE_URL}/api/apps`, { data: { name: first, workspacePath: process.cwd(), githubRepo: null } });

  await page.goto('/');
  const row = page.getByRole('navigation', { name: 'Chats' }).getByTestId(`chat-row-${chat.id}`);
  await expect(row).toBeVisible();
  const appsInMenu = async () => {
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to app…' }).click();
    const names = await page.getByRole('menu', { name: 'Move to app…' }).getByRole('menuitemradio').allTextContents();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    return names;
  };

  // The Code window, which is another page holding its own lists, makes the app.
  const name = `Made elsewhere ${suffix}`;
  const created = await request.post(`${BASE_URL}/api/apps`, { data: { name, workspacePath: process.cwd(), githubRepo: null } });
  const { id } = (await created.json()) as { id: string };
  await expect.poll(appsInMenu).toContain(name);

  await request.patch(`${BASE_URL}/api/apps/${id}`, { data: { name: `${name} renamed` } });
  await expect.poll(appsInMenu).toContain(`${name} renamed`);

  await request.delete(`${BASE_URL}/api/apps/${id}`);
  await expect.poll(appsInMenu).not.toContain(`${name} renamed`);
});

test('a reply sent from another window shows up in a chat already open here', async ({ page, request }) => {
  const conn = await request.post(`${BASE_URL}/api/connections`, { data: { name: 'Mock', kind: 'mock' } });
  const { id: connectionId } = await conn.json();
  const profile = (await (await request.post(`${BASE_URL}/api/profiles`, { data: { name: 'Mock Profile', connectionId, modelId: 'mock-standard' } })).json()) as { id: string };
  const title = `Watched ${randomUUID().slice(0, 8)}`;
  const chat = (await (await request.post(`${BASE_URL}/api/chats`, { data: { profileId: profile.id, title } })).json()) as { id: string };

  await page.goto('/');
  await page.getByRole('navigation', { name: 'Chats' }).getByTestId(`chat-row-${chat.id}`).click();
  const thread = page.getByTestId('thread-scroll');

  // Another window (or the other machine) sends a turn in this chat.
  const sent = await request.post(`${BASE_URL}/api/chats/${chat.id}/turns`, {
    data: { parentId: null, parts: [{ type: 'text', text: 'sent from somewhere else' }], profileIds: [profile.id] },
  });
  expect(sent.status()).toBe(202);
  const { userMessageId } = (await sent.json()) as { userMessageId: string };
  await request.post(`${BASE_URL}/api/chats/${chat.id}/head`, { data: { messageId: userMessageId } });

  await expect(thread.getByText('sent from somewhere else')).toBeVisible();
  await expect(thread.getByText(/Here is a mock reply from OtherBench/)).toBeVisible();
});
