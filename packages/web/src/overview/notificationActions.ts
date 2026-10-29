import type { App } from '@otherbench/core/ports/store.js';
import type { GithubNotification } from '@otherbench/core/types/overview.js';
import { startChatFromIssue } from '../code/startChatFromIssue.js';
import { openInBrowser } from '../desktop/bridge.js';
import { toast } from '../lib/toasts.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { openIssue } from './openFromOverview.js';

/*
 * What the Overview's GitHub inbox rows do (spec 2026-10-29-github-inbox-design):
 * open a notification where it belongs, start a chat on it, and mark it done
 * on GitHub.
 */

function markRead(n: GithubNotification): void {
  if (!n.unread) return;
  api.overview
    .markRead(n.id)
    .then((overview) => useOtherBenchStore.getState().setOverview(overview))
    .catch((err: unknown) => console.error(`[otherbench-web] failed to mark notification ${n.id} read:`, err));
}

/**
 * Opens a notification: an issue in a repo that is an app in that app's
 * Issues view (in the Code window when Code is undocked), anything else in
 * the browser. Either way it is marked read on GitHub, quietly.
 */
export function openNotification(n: GithubNotification, appId: string | null): void {
  if (n.kind === 'issue' && n.number !== null && appId !== null) openIssue(appId, n.number, 'open');
  else openInBrowser(n.url).catch((err: unknown) => console.error(`[otherbench-web] failed to open ${n.url}:`, err));
  markRead(n);
}

/**
 * GitHub's Done: the row goes straight away, and comes back with a toast if
 * GitHub refuses (Done can't be undone through GitHub's API, so it is only
 * ever one notification at a time).
 */
export async function doneNotification(n: GithubNotification): Promise<void> {
  const { overview, setOverview } = useOtherBenchStore.getState();
  if (overview !== null) {
    setOverview({
      ...overview,
      tiles: overview.tiles.map((t) =>
        t.notifications?.some((x) => x.id === n.id)
          ? { ...t, notifications: t.notifications.filter((x) => x.id !== n.id), count: t.count - 1 }
          : t
      ),
      total: overview.total - 1,
    });
  }
  try {
    setOverview(await api.overview.markDone(n.id));
  } catch (err) {
    console.error(`[otherbench-web] failed to mark notification ${n.id} done:`, err);
    if (overview !== null) setOverview(overview);
    toast({ text: "Couldn't mark that done on GitHub.", tone: 'error' });
  }
}

/** The new chat's title and what its composer starts with, for anything but an issue (which `startChatFromIssue` drafts). */
export function notificationDraft(
  n: GithubNotification,
  pr: { title: string; url: string; branch: string; body: string } | null
): { title: string; draft: string } {
  if (n.kind === 'pr' && pr !== null) {
    const head = `PR #${n.number ?? ''} ${pr.title}`;
    const lines = `${head}\n${pr.url}\nBranch: ${pr.branch}`;
    return { title: head, draft: pr.body.trim() === '' ? lines : `${lines}\n\n${pr.body}` };
  }
  if (n.kind === 'ci') return { title: `CI: ${n.title}`, draft: `${n.title}\n${n.url}\n\nFind out why this failed and fix it.` };
  return { title: n.title, draft: `${n.title}\n${n.url}` };
}

/**
 * "Start a chat on this" for a notification: a new code chat in the app,
 * opened, with the notification's subject in its composer. Never sent, so
 * direction can be added first, and the notification stays in the inbox
 * until it is marked done. A failed fetch or create opens nothing and rejects.
 */
export async function startChatFromNotification(app: App, n: GithubNotification): Promise<void> {
  if (n.kind === 'issue' && n.number !== null) {
    await startChatFromIssue(app, await api.apps.issues.get(app.id, n.number));
    return;
  }
  const pr = n.kind === 'pr' && n.number !== null ? await api.apps.pulls.get(app.id, n.number) : null;
  const { title, draft } = notificationDraft(n, pr);
  const chat = await api.chats.create({ appId: app.id, title });
  const { upsertChat, prefillComposer, setActiveChatId } = useOtherBenchStore.getState();
  upsertChat(chat);
  prefillComposer(chat.id, draft);
  setActiveChatId(chat.id);
}
