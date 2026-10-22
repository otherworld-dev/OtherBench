import type { App } from '@otherbench/core/ports/store.js';
import type { IssueDetail } from '@otherbench/core/types/code.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';

/** What the new chat's box starts with: the issue's number and title, its URL, then its body when it has one. */
export function issueDraft(issue: IssueDetail): string {
  const head = `#${issue.number} ${issue.title}\n${issue.url}`;
  return issue.body.trim() === '' ? head : `${head}\n\n${issue.body}`;
}

/**
 * "Start a chat on this" (spec 2026-10-20-code-tab-design, Goal 7): a new
 * chat in the app, titled after the issue, opened, with the issue in its
 * composer. It is never sent: the spec's "Calls I made" has the composer
 * pre-filled so Adam can add direction first. The server gives the chat the
 * app's folder and default profile, as for the sidebar's "+ New chat".
 *
 * The chat is put in the store before it is opened, so the pane never shows
 * an id it doesn't know, and the box's text is handed over before that too,
 * so the composer finds it when it mounts. A failed create opens nothing and
 * rejects, for the caller to show. The new chat's Issues view opens on the
 * issue, so the issue is at hand while the chat works on it.
 */
export async function startChatFromIssue(app: App, issue: IssueDetail): Promise<void> {
  const chat = await api.chats.create({ appId: app.id, title: `#${issue.number} ${issue.title}` });
  const { upsertChat, prefillComposer, setActiveChatId, cacheIssue, setIssueView } = useOtherBenchStore.getState();
  upsertChat(chat);
  cacheIssue(app.id, issue);
  setIssueView(chat.id, { state: issue.state, selected: issue.number });
  prefillComposer(chat.id, issueDraft(issue));
  // Shown in the pane, not made a tab, as the sidebar's "+ New chat" does.
  setActiveChatId(chat.id);
}
