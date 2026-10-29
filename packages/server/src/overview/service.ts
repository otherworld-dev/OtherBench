import { buildOverview, CHAT_NEED_WINDOW_MS, chatNeedsYou } from '@otherbench/core/domain/overview.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { DeckBoardView } from '@otherbench/core/types/nextcloud.js';
import type { GithubNotification, Overview } from '@otherbench/core/types/overview.js';
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
  github: () => Pick<GithubService, 'login' | 'notifications' | 'markDone' | 'markRead'>;
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

type DeckResult = { view: DeckBoardView } | { error: string };

const NEXTCLOUD_NOT_SET_UP = "Nextcloud isn't set up";

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? 'unknown error';
}

const githubError = (err: unknown): string => `couldn't check GitHub: ${firstLine(err)}`;
const deckError = (err: unknown): string => `couldn't check Deck: ${firstLine(err)}`;

/**
 * The Overview (spec 2026-10-26-overview-design): checks GitHub (the user's
 * notifications inbox through the machine's own gh, spec
 * 2026-10-29-github-inbox-design) and Deck (each app's board) in the
 * background every 15 minutes and on refresh, and builds the Overview on
 * request from that cache and the live store. Chats are never cached: they
 * are read from the store on every view, so they're always current.
 *
 * A failure is kept as a one-line error the tile shows: a board's on its app
 * only, the inbox's on every GitHub section, which keeps showing the last list
 * it read. While no app has a repo, a check runs no gh at all.
 */
export class OverviewService {
  private readonly store: Store;
  private readonly deps: OverviewDeps;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  /** The last inbox gh read; null before the first good read. */
  private inbox: { list: GithubNotification[]; more: boolean } | null = null;
  /** Why the last check couldn't read the inbox (or the login); null when it could. */
  private inboxError: string | null = null;
  private decks: Record<string, DeckResult> = {};
  private login: string | null = null;
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
    const notifications =
      this.inbox === null && this.inboxError === null ? null : { list: this.inbox?.list ?? [], more: this.inbox?.more ?? false, error: this.inboxError };
    return buildOverview({
      apps,
      chats,
      projects: this.store.projects.list().map((p) => ({ id: p.id, name: p.name })),
      heads: this.store.messages.heads(),
      waitingChatIds: waiting,
      me,
      notifications,
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

  /** GitHub's Done on a thread: once GitHub has it, it leaves the list. GitHub's refusal is thrown and changes nothing. */
  async markDone(id: string): Promise<void> {
    await this.deps.github().markDone(id);
    if (this.inbox !== null) this.inbox = { ...this.inbox, list: this.inbox.list.filter((n) => n.id !== id) };
    this.changed();
  }

  /** Marks a thread read on GitHub, then in the list. */
  async markRead(id: string): Promise<void> {
    await this.deps.github().markRead(id);
    if (this.inbox !== null) this.inbox = { ...this.inbox, list: this.inbox.list.map((n) => (n.id === id ? { ...n, unread: false } : n)) };
    this.changed();
  }

  /**
   * Ticks off chats needing the user from before `before` (ms): ones whose latest reply is older (not ones
   * waiting on a card or question, which only answering clears). The inbox is never touched: Done on GitHub
   * can't be undone through its API, so notifications are cleared one at a time (spec 2026-10-29-github-inbox-design).
   */
  tickOlder(before: number): { chats: number } {
    const now = this.now();
    const machines = this.deps.machines();
    const waiting = new Set([...this.deps.waitingChatIds(), ...machines.flatMap((m) => m.waitingChatIds)]);
    const heads = new Map(this.store.messages.heads().map((h) => [h.chatId, h]));
    let chats = 0;
    for (const chat of this.store.chats.list()) {
      if (waiting.has(chat.id)) continue;
      const head = heads.get(chat.id) ?? null;
      if (!head || head.createdAt >= before || !chatNeedsYou(chat, head, false, now - CHAT_NEED_WINDOW_MS)) continue;
      this.store.chats.update(chat.id, { dealtWithAt: now });
      chats++;
    }
    if (chats > 0) this.changed();
    return { chats };
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

    // No gh at all while no app has a repo: nothing would use the login or the inbox.
    let inbox = this.inbox;
    let inboxError: string | null = null;
    if (apps.some((a) => a.githubRepo !== null)) {
      let login: string | null = null;
      try {
        login = await this.deps.github().login();
      } catch (err) {
        inboxError = githubError(err);
      }
      if (this.disposed) return;
      if (login !== this.login) {
        this.login = login;
        this.deps.onLoginChanged?.();
      }
      if (inboxError === null) {
        try {
          inbox = await this.deps.github().notifications();
        } catch (err) {
          inboxError = githubError(err);
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

    this.inbox = inbox;
    this.inboxError = inboxError;
    this.decks = decks;
    this.checkedAt = this.now();
  }
}
