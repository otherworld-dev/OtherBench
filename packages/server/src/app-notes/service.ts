import {
  APP_NOTES_FALLBACK_SECTION,
  APP_NOTES_PAGE_TITLE,
  appNotesMirrorText,
  editFact,
  emptyAppNotesBody,
  factPlacementPrompt,
  moveFact,
  parseFactPlacement,
  placeFact,
  removeFact,
  validateAppNotes,
  type AppNotesMirror,
  type AppNotesView,
  type FactSaved,
} from '@otherbench/core/domain/app-notes.js';
import type { ChatEngine } from '@otherbench/core/ports/chat-engine.js';
import type { App, AppNotes, Store } from '@otherbench/core/ports/store.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import { CodeRouteError } from '../code/route-errors.js';
import type { NextcloudClient } from '../nextcloud/client.js';
import { writeWikiPage } from '../nextcloud/wiki.js';
import { appDefaultProfileId } from '../profile-resolution.js';
import { realScheduler, type Scheduler } from '../memory/scheduler.js';
import { askMemoryModel, errorMessage, pickMemoryProfile } from '../memory/shared.js';

/** How long filing a fact may wait on the model before it goes under the fallback heading. */
export const FACT_PLACEMENT_TIMEOUT_MS = 45_000;
/** How often notes that didn't reach Collectives are tried again. */
export const MIRROR_RETRY_MS = 10 * 60_000;

export interface AppNotesServiceDeps {
  store: Store;
  engine: ChatEngine;
  resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  /** This machine's Nextcloud; throws a CodeRouteError ('nextcloud-off', 'nextcloud-not-configured') when there's none to use. */
  nextcloud: () => Promise<NextcloudClient>;
  now?: () => number;
  scheduler?: Scheduler;
  timeoutMs?: number;
}

/**
 * An app's notes (spec 2026-11-05-app-notes-design): saving them, filing a
 * fact typed with `#` or offered by a model (the memory model picks its
 * heading and the line it replaces), and the one-way copy to Collectives,
 * written after every save and retried every `MIRROR_RETRY_MS` until it lands.
 */
export class AppNotesService {
  private readonly store: Store;
  private readonly engine: ChatEngine;
  private readonly resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  private readonly nextcloud: () => Promise<NextcloudClient>;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly timeoutMs: number;
  /** appId -> the last failed write to Collectives, until one lands. */
  private readonly failures = new Map<string, { at: number; error: string }>();
  /** appId -> the page's url after the last good write. */
  private readonly urls = new Map<string, string>();
  /** appId -> the write in flight; the next waits for it. */
  private readonly writing = new Map<string, Promise<void>>();
  private readonly running = new Set<() => void>();
  private retryTimer: unknown;
  private disposed = false;

  constructor(deps: AppNotesServiceDeps) {
    this.store = deps.store;
    this.engine = deps.engine;
    this.resolveProfile = deps.resolveProfile;
    this.nextcloud = deps.nextcloud;
    this.now = deps.now ?? Date.now;
    this.scheduler = deps.scheduler ?? realScheduler;
    this.timeoutMs = deps.timeoutMs ?? FACT_PLACEMENT_TIMEOUT_MS;
  }

  /** The app's notes (the starting headings if never saved) and where their copy stands. */
  view(app: App): AppNotesView {
    return { notes: this.notesOf(app.id), mirror: this.mirrorOf(app) };
  }

  /** Replaces the notes (the Notes tab's Edit) and copies them to Collectives. */
  save(app: App, body: string, sourceChatId: string | null = null): AppNotesView {
    // Each save's time is later than the last, so "copied" (mirroredAt equals it) names exactly one version.
    const at = Math.max(this.now(), (this.store.appNotes.get(app.id)?.updatedAt ?? 0) + 1);
    this.store.appNotes.save(app.id, body, sourceChatId, at);
    void this.mirror(app.id);
    return this.view(app);
  }

  /** Puts an earlier version back, as a new save. Null for a version that isn't this app's. */
  restore(app: App, versionId: string): AppNotesView | null {
    const version = this.store.appNotes.version(versionId);
    if (!version || version.appId !== app.id) return null;
    return this.save(app, version.body);
  }

  /**
   * Files a fact: the memory model picks its heading (or `section` when it's
   * given and the model can't be asked) and the line it replaces. Without a
   * model, or when it fails, the fact goes under `section` or the fallback
   * heading and replaces nothing. The notes are read again after the model
   * answers, so nothing saved meanwhile is lost.
   */
  async addFact(app: App, text: string, section: string | null, chatId: string | null): Promise<FactSaved> {
    const before = this.notesOf(app.id).body;
    const placement = (await this.place(app, before, text, section)) ?? { section: section || APP_NOTES_FALLBACK_SECTION, replaces: null };
    const fact = placeFact(this.notesOf(app.id).body, text, placement.section, placement.replaces);
    const tooBig = validateAppNotes(fact.body);
    if (tooBig) throw new CodeRouteError(409, 'notes-full', `${tooBig} Tidy them in the Notes tab first.`);
    const view = this.save(app, fact.body, chatId);
    return { ...view, fact };
  }

  /** Changes one line in place. */
  editFact(app: App, line: string, text: string): AppNotesView {
    return this.save(app, editFact(this.notesOf(app.id).body, line, text));
  }

  /** Moves one line under another heading. */
  moveFact(app: App, line: string, toSection: string): AppNotesView {
    return this.save(app, moveFact(this.notesOf(app.id).body, line, toSection));
  }

  /** Takes a filed fact back out, putting back the line it replaced. */
  undoFact(app: App, line: string, section: string, replaced: string | null): AppNotesView {
    let body = removeFact(this.notesOf(app.id).body, line);
    if (replaced !== null) body = placeFact(body, replaced, section).body;
    return this.save(app, body);
  }

  /** Copies the app's notes to Collectives now. Never rejects; a failure is kept for the Notes tab and retried later. */
  mirror(appId: string): Promise<void> {
    const previous = this.writing.get(appId) ?? Promise.resolve();
    const next = previous.then(() => this.write(appId));
    this.writing.set(appId, next);
    void next.finally(() => {
      if (this.writing.get(appId) === next) this.writing.delete(appId);
    });
    return next;
  }

  /** Copies every app's notes that changed since their last good copy. */
  async sweep(): Promise<void> {
    if (this.disposed) return;
    const waits = this.store.appNotes
      .list()
      .filter((n) => n.mirroredAt !== n.updatedAt)
      .map((n) => this.mirror(n.appId));
    await Promise.all(waits);
  }

  /** Sweeps now and every `MIRROR_RETRY_MS`. */
  start(): void {
    void this.sweep();
    const tick = (): void => {
      if (this.disposed) return;
      void this.sweep();
      this.retryTimer = this.scheduler.setTimeout(tick, MIRROR_RETRY_MS);
    };
    this.retryTimer = this.scheduler.setTimeout(tick, MIRROR_RETRY_MS);
  }

  /** Resolves once every write in flight has finished. */
  async idle(): Promise<void> {
    while (this.writing.size > 0) await Promise.all([...this.writing.values()]);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== undefined) this.scheduler.clearTimeout(this.retryTimer);
    for (const stop of [...this.running]) stop();
  }

  private notesOf(appId: string): AppNotes {
    return this.store.appNotes.get(appId) ?? { appId, body: emptyAppNotesBody(), updatedAt: 0, sourceChatId: null, mirroredAt: null };
  }

  private mirrorOf(app: App): AppNotesMirror {
    const settings = this.store.settings.get();
    if (!settings.nextcloudEnabled) return { state: 'off' };
    if (app.wikiCollective === null || app.wikiPagePath === null) return { state: 'no-page' };
    const notes = this.store.appNotes.get(app.id);
    const failure = this.failures.get(app.id);
    if (notes && notes.mirroredAt === notes.updatedAt) return { state: 'mirrored', at: notes.updatedAt, url: this.urls.get(app.id) ?? null };
    if (failure) return failure.error === NOT_CONFIGURED ? { state: 'not-configured' } : { state: 'failed', ...failure };
    return notes ? { state: 'pending' } : { state: 'nothing' };
  }

  private async write(appId: string): Promise<void> {
    if (this.disposed) return;
    const app = this.store.apps.get(appId);
    const notes = this.store.appNotes.get(appId);
    if (!app || !notes || app.wikiCollective === null || app.wikiPagePath === null) return;
    if (notes.mirroredAt === notes.updatedAt) return;
    try {
      const client = await this.nextcloud();
      const url = await writeWikiPage(client, app.wikiCollective, `${app.wikiPagePath}/${APP_NOTES_PAGE_TITLE}`, appNotesMirrorText(notes.body));
      if (this.disposed) return;
      // The copy is of the notes as read above: a save since leaves them still to copy.
      this.store.appNotes.markMirrored(appId, notes.updatedAt);
      this.failures.delete(appId);
      this.urls.set(appId, url);
    } catch (err) {
      if (this.disposed) return;
      if (err instanceof CodeRouteError && err.code === 'nextcloud-off') return;
      const error = err instanceof CodeRouteError && err.code === 'nextcloud-not-configured' ? NOT_CONFIGURED : errorMessage(err);
      this.failures.set(appId, { at: this.now(), error });
      if (error !== NOT_CONFIGURED) console.warn(`[otherbench-server] copying app ${appId}'s notes to Collectives failed: ${error}`);
    }
  }

  /** The model's heading and replaced line for a fact, or null when it can't say. */
  private async place(app: App, body: string, text: string, section: string | null): Promise<{ section: string; replaces: string | null } | null> {
    try {
      const chosen = this.store.settings.get().memoryProfileId;
      const profile = await pickMemoryProfile(this.store, this.resolveProfile, [chosen, app.defaultProfileId, appDefaultProfileId(this.store)], chosen);
      if (!profile) return null;
      const answer = await askMemoryModel(
        { engine: this.engine, scheduler: this.scheduler, now: this.now, timeoutMs: this.timeoutMs, running: this.running },
        profile,
        `app-notes:${app.id}`,
        null,
        factPlacementPrompt(body, text, section)
      );
      if (!answer.ok) {
        console.warn(`[otherbench-server] filing a fact in app ${app.id}'s notes: ${answer.error}`);
        return null;
      }
      return parseFactPlacement(answer.text, body);
    } catch (err) {
      console.warn(`[otherbench-server] filing a fact in app ${app.id}'s notes: ${errorMessage(err)}`);
      return null;
    }
  }
}

/** A failure that is only "Nextcloud isn't set up here": shown as that, not as an error. */
const NOT_CONFIGURED = 'not-configured';
