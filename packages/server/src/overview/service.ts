import { buildOverview, chatNeedsYou } from '@otherbench/core/domain/overview.js';
import type { IssueTick, Store } from '@otherbench/core/ports/store.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { DeckBoardView } from '@otherbench/core/types/nextcloud.js';
import type { IssueActivity, Overview } from '@otherbench/core/types/overview.js';
import type { GithubService } from '../code/github.js';
import { realScheduler, type Scheduler } from '../memory/scheduler.js';
import type { NextcloudClient } from '../nextcloud/client.js';
import { boardView } from '../nextcloud/deck.js';

/** How often GitHub and Deck are checked in the background (spec 2026-10-26-overview-design, "Freshness"). */
export const OVERVIEW_INTERVAL_MS = 15 * 60_000;

/** A paired machine, as the Overview needs it. */
export interface OverviewMachine {
  nodeId: string;
  name: string;
  reachable: boolean;
  /** Its chats waiting on an approval card or a question; empty while it isn't reachable. */
  waitingChatIds: string[];
  /** Its `gh` login; null if none, unknown, or while it isn't reachable. */
  githubLogin: string | null;
}

export interface OverviewDeps {
  store: Store;
  github: () => Pick<GithubService, 'activity' | 'login'>;
  /** null = Nextcloud isn't set up on this machine. */
  nextcloud: () => Promise<NextcloudClient | null>;
  /** This machine's chats waiting on an approval card or a question. */
  waitingChatIds: () => string[];
  machines: () => OverviewMachine[];
  emit: (e: AppEvent) => void;
  /** Called when a check finds a different `gh` login (including none). */
  onLoginChanged?: () => void;
  scheduler?: Scheduler;
  now?: () => number;
}

export type OverviewErrorCode = 'not-needing';

export class OverviewError extends Error {
  constructor(
    readonly code: OverviewErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'OverviewError';
  }
}

type IssuesResult = { activity: IssueActivity[] } | { error: string };
type DeckResult = { view: DeckBoardView } | { error: string };

const NEXTCLOUD_NOT_SET_UP = "Nextcloud isn't set up";

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? 'unknown error';
}

const issuesError = (err: unknown): string => `couldn't check issues: ${firstLine(err)}`;
const deckError = (err: unknown): string => `couldn't check Deck: ${firstLine(err)}`;

/**
 * The Overview (spec 2026-10-26-overview-design): checks GitHub (each app's
 * repo, through the machine's own gh) and Deck (each app's board) in the
 * background every 15 minutes and on refresh, and builds the Overview on
 * request from that cache and the live store. Chats are never cached: they
 * are read from the store on every view, so they're always current.
 *
 * A check runs the calls one after another, and a failure is kept per app as
 * a one-line error the tile shows, so one bad repo or board never hides the
 * others. A check that can't read the gh login puts that error on every app
 * with a repo, since without it nothing can say which issues need the user;
 * while no app has a repo, a check runs no gh at all.
 */
export class OverviewService {
  private readonly store: Store;
  private readonly deps: OverviewDeps;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private issues: Record<string, IssuesResult> = {};
  private decks: Record<string, DeckResult> = {};
  private login: string | null = null;
  /** Why the last check couldn't read the gh login; null when it could (or before the first check). */
  private loginError: string | null = null;
  private checkedAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  private disposed = false;

  constructor(deps: OverviewDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.scheduler = deps.scheduler ?? realScheduler;
    this.now = deps.now ?? Date.now;
  }

  /** Checks now, then every OVERVIEW_INTERVAL_MS. */
  start(): void {
    this.tick();
  }

  /** Checks now; a call while a check is running shares it. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed) return Promise.resolve();
    // `checking` is read from inFlight, so each event goes once it has flipped.
    const run = this.check().finally(() => {
      this.inFlight = null;
      if (!this.disposed) this.changed();
    });
    this.inFlight = run;
    this.changed();
    return run;
  }

  /** The Overview from the last check and the store as it is now. Never runs gh or reaches Nextcloud. */
  view(): Overview {
    const apps = this.store.apps.list();
    const chats = this.store.chats.list();
    const machines = this.deps.machines();
    const waiting = new Set([...this.deps.waitingChatIds(), ...machines.flatMap((m) => m.waitingChatIds)]);
    const me = this.login;
    // Without the login no issue can be judged, so every repo app says why, even one given its repo since the check.
    const issues: Record<string, IssuesResult> =
      this.loginError === null
        ? this.issues
        : Object.fromEntries(apps.filter((a) => a.githubRepo !== null).map((a) => [a.id, { error: this.loginError as string }]));
    return buildOverview({
      apps,
      chats,
      projects: this.store.projects.list().map((p) => ({ id: p.id, name: p.name })),
      heads: this.store.messages.heads(),
      waitingChatIds: waiting,
      me,
      issues,
      ticks: this.store.issueTicks.list(),
      decks: this.decks,
      checkedAt: this.checkedAt,
      checking: this.inFlight !== null,
      // A machine that can't be reached matters only if a chat it runs could be waiting on the user.
      unreachableMachines: machines
        .filter((m) => !m.reachable && chats.some((c) => c.runsOn === m.nodeId && c.archivedAt === null))
        .map((m) => m.name),
      // Only once this machine knows its own login: before that every other one would look different.
      loginMismatches:
        me === null
          ? []
          : machines.filter((m) => m.reachable && m.githubLogin !== null && m.githubLogin !== me).map((m) => ({ machine: m.name, login: m.githubLogin as string })),
      now: new Date(this.now()),
    });
  }

  /** The gh login the last check found; null before the first check or when it couldn't be read. */
  githubLogin(): string | null {
    return this.login;
  }

  /** Ticks an issue off through its latest activity from someone else. Throws OverviewError('not-needing') if it doesn't need the user. */
  tickIssue(appId: string, number: number): IssueTick {
    const issue = this.view()
      .tiles.find((t) => t.appId === appId)
      ?.issues?.find((i) => i.number === number);
    if (!issue) throw new OverviewError('not-needing', `Issue #${number} doesn't need you.`);
    const tick = this.store.issueTicks.set(appId, number, issue.through);
    this.changed();
    return tick;
  }

  /**
   * Ticks off everything needing the user from before `before` (ms): chats
   * whose latest reply is older (not ones waiting on a card or question,
   * which only answering clears), and issues whose latest activity is older.
   */
  tickOlder(before: number): { chats: number; issues: number } {
    const now = this.now();
    const machines = this.deps.machines();
    const waiting = new Set([...this.deps.waitingChatIds(), ...machines.flatMap((m) => m.waitingChatIds)]);
    const heads = new Map(this.store.messages.heads().map((h) => [h.chatId, h]));
    let chats = 0;
    for (const chat of this.store.chats.list()) {
      if (waiting.has(chat.id)) continue;
      const head = heads.get(chat.id) ?? null;
      if (!head || head.createdAt >= before || !chatNeedsYou(chat, head, false)) continue;
      this.store.chats.update(chat.id, { dealtWithAt: now });
      chats++;
    }
    let issues = 0;
    for (const tile of this.view().tiles) {
      if (tile.appId === null) continue;
      for (const issue of tile.issues ?? []) {
        if (!(Date.parse(issue.at) < before)) continue;
        this.store.issueTicks.set(tile.appId, issue.number, issue.through);
        issues++;
      }
    }
    if (chats > 0 || issues > 0) this.changed();
    return { chats, issues };
  }

  /** Stops the timer. A check already running finishes but changes nothing. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Arms the next check, then checks: the interval runs from each check's start, whatever it takes. */
  private tick(): void {
    if (this.disposed) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, OVERVIEW_INTERVAL_MS);
    this.refresh().catch((err: unknown) => console.error('[otherbench-server] the overview check failed:', err));
  }

  private changed(): void {
    this.deps.emit({ type: 'overview-changed' });
  }

  private async check(): Promise<void> {
    const apps = this.store.apps.list();

    // No gh at all while no app has a repo: nothing would use the login.
    const repoApps = apps.filter((a) => a.githubRepo !== null);
    const issues: Record<string, IssuesResult> = {};
    if (repoApps.length > 0) {
      let login: string | null = null;
      let loginError: string | null = null;
      try {
        login = await this.deps.github().login();
      } catch (err) {
        loginError = issuesError(err);
      }
      if (this.disposed) return;
      if (login !== this.login) {
        this.login = login;
        this.deps.onLoginChanged?.();
      }
      this.loginError = loginError;

      for (const app of repoApps) {
        if (loginError !== null) {
          issues[app.id] = { error: loginError };
          continue;
        }
        try {
          issues[app.id] = { activity: await this.deps.github().activity(app.githubRepo as string) };
        } catch (err) {
          issues[app.id] = { error: issuesError(err) };
        }
        if (this.disposed) return;
      }
    }

    const decks: Record<string, DeckResult> = {};
    const boardApps = apps.filter((a) => a.deckBoardId !== null);
    if (boardApps.length > 0) {
      let client: NextcloudClient | null = null;
      let clientError: string | null = null;
      try {
        client = await this.deps.nextcloud();
        if (client === null) clientError = NEXTCLOUD_NOT_SET_UP;
      } catch (err) {
        clientError = deckError(err);
      }
      if (this.disposed) return;
      for (const app of boardApps) {
        if (client === null) {
          decks[app.id] = { error: clientError ?? NEXTCLOUD_NOT_SET_UP };
          continue;
        }
        try {
          decks[app.id] = { view: await boardView(client, app.deckBoardId as number) };
        } catch (err) {
          decks[app.id] = { error: deckError(err) };
        }
        if (this.disposed) return;
      }
    }

    this.issues = issues;
    this.decks = decks;
    this.checkedAt = this.now();
  }
}
