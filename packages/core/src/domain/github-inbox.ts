/** The GitHub notifications inbox, as the Overview shows it (spec 2026-10-29-github-inbox-design). */
import type { GithubNotification, NotificationKind } from '../types/overview.js';

/** What a notification is about, from GitHub's subject type. */
export function notificationKind(subjectType: string): NotificationKind {
  switch (subjectType) {
    case 'Issue':
      return 'issue';
    case 'PullRequest':
      return 'pr';
    case 'CheckSuite':
    case 'WorkflowRun':
      return 'ci';
    case 'Release':
      return 'release';
    case 'Discussion':
      return 'discussion';
    default:
      return 'other';
  }
}

const API_REPO_PATH = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/(.+)$/;

/**
 * Where a notification opens. Its subject address is an API one: issues and
 * releases map straight onto github.com, a PR's `pulls/N` is `pull/N` there.
 * CI has no subject address, so it goes to the repo's Actions page, and
 * anything unrecognised to the repo itself.
 */
function webUrl(repo: string, kind: NotificationKind, apiUrl: string | null): { url: string; number: number | null } {
  const base = `https://github.com/${repo}`;
  if (kind === 'ci') return { url: `${base}/actions`, number: null };
  const path = apiUrl === null ? null : API_REPO_PATH.exec(apiUrl)?.[1] ?? null;
  if (path === null) return { url: base, number: null };
  const issue = /^issues\/(\d+)$/.exec(path);
  if (issue) return { url: `${base}/issues/${issue[1]}`, number: Number(issue[1]) };
  const pull = /^pulls\/(\d+)$/.exec(path);
  if (pull) return { url: `${base}/pull/${pull[1]}`, number: Number(pull[1]) };
  return { url: `${base}/${path}`, number: null };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** One entry of `GET /notifications`, or null when it lacks its id, repo or title. */
export function parseNotification(raw: unknown): GithubNotification | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { id?: unknown; unread?: unknown; reason?: unknown; updated_at?: unknown; subject?: { title?: unknown; url?: unknown; type?: unknown }; repository?: { full_name?: unknown } };
  const id = str(r.id);
  const repo = str(r.repository?.full_name);
  const title = str(r.subject?.title);
  if (id === null || !/^\d+$/.test(id) || repo === null || title === null) return null;
  const kind = notificationKind(str(r.subject?.type) ?? '');
  const { url, number } = webUrl(repo, kind, str(r.subject?.url));
  return { id, repo, kind, title, number, reason: str(r.reason) ?? 'subscribed', unread: r.unread === true, updatedAt: str(r.updated_at) ?? '', url };
}

/** The app whose repo `repo` is, compared without case; the first such app when two share it. */
export function appForRepo<A extends { githubRepo: string | null }>(apps: readonly A[], repo: string): A | null {
  const wanted = repo.toLowerCase();
  return apps.find((a) => a.githubRepo !== null && a.githubRepo.toLowerCase() === wanted) ?? null;
}

/** Unread first, then the most recently updated. */
export function sortNotifications(list: readonly GithubNotification[]): GithubNotification[] {
  return [...list].sort((a, b) => Number(b.unread) - Number(a.unread) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
