import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as breathe } from 'node:timers/promises';
import { planClaudeImport, safeFileName, type ImportedChat, type ImportedProject, type ImportPlan } from '@grunt/core/domain/claude-import.js';
import { finaliseImportedAbout, importAboutPrompt, importGlobalNotePrompt, importProjectNotePrompt } from '@grunt/core/domain/claude-import-memory.js';
import { emptyGlobalMemoryBody, finaliseGlobalSummary, GLOBAL_MEMORY_HEADINGS } from '@grunt/core/domain/global-memory.js';
import { emptyMemoryBody, finaliseSummary, hasMemoryContent, MEMORY_HEADINGS } from '@grunt/core/domain/memory.js';
import { containPath } from '@grunt/core/domain/paths.js';
import { classifyPath, MAX_EXTRA_FOLDERS, sameWorkspace } from '@grunt/core/domain/workspace.js';
import type { ChatEngine } from '@grunt/core/ports/chat-engine.js';
import type { Project, Store } from '@grunt/core/ports/store.js';
import type { ImportPhase, ImportPreview, ImportReport, ImportStatus, MemoryOutcome } from '@grunt/core/types/claude-import.js';
import type { Profile, ResolvedProfile } from '@grunt/core/types/config.js';
import { askMemoryModel, errorMessage, MEMORY_UPDATE_TIMEOUT_MS, pickMemoryProfile, type MemoryQueue } from '../memory/shared.js';
import { realScheduler, type Scheduler } from '../memory/scheduler.js';
import { appDefaultProfileId } from '../profile-resolution.js';
import type { AppEventBus } from '../stream/events.js';
import { readClaudeExport, type ClaudeExportRead } from './claude-reader.js';

/**
 * Import from claude.ai (spec 2026-10-09-claude-import-design): previews an
 * export and runs the import as one background job at a time. Chats go in one
 * transaction each, so a chat is either all there or not at all and a re-run
 * skips it; project docs and claude.ai's memory files are written under
 * `importRoot`; memory is condensed by the memory model on the summariser's
 * queue, so it never runs alongside a summariser update.
 */

/** A request the import can't act on (a 400): a bad profile, say. */
export class ImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportInputError';
  }
}

/** An import is already running (a 409). */
export class ImportBusyError extends Error {
  constructor() {
    super('An import is already running.');
    this.name = 'ImportBusyError';
  }
}

export interface ClaudeImportDeps {
  store: Store;
  engine: ChatEngine;
  resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  /** The memory summarisers' queue: condensing waits its turn behind them. */
  queue: MemoryQueue;
  /** Announces a chat whose transaction rolled back after it was announced. */
  events?: AppEventBus;
  /** Where docs and claude.ai's memory files go; made when first needed. */
  importRoot: string;
  read?: (folder: string) => Promise<ClaudeExportRead>;
  scheduler?: Scheduler;
  now?: () => number;
  timeoutMs?: number;
}

/** The chat id memory calls are made under: the import has no chat of its own. */
const IMPORT_CHAT_ID = 'claude-import';
/** A condensed note with nothing in it isn't saved: claude.ai's notes sometimes only say there's nothing to note yet. */
const NOTHING_TO_KEEP = "claude.ai's notes had nothing worth keeping.";
/** Chats written between yields to the event loop, so status polls and streams keep moving. */
const CHATS_PER_BREATH = 20;

const IDLE: ImportStatus = { state: 'idle', phase: null, done: 0, total: 0, startedAt: null, finishedAt: null, report: null, error: null };

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function skipped(reason: string): MemoryOutcome {
  return { status: 'skipped', reason };
}

function failed(reason: string): MemoryOutcome {
  return { status: 'failed', reason };
}

export class ClaudeImportService {
  private current: ImportStatus = IDLE;
  /** Set from the moment a start is accepted, before the export is read, so two starts can't both run. */
  private busy = false;
  private job: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly running = new Set<() => void>();
  private readonly read: (folder: string) => Promise<ClaudeExportRead>;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ClaudeImportDeps) {
    this.read = deps.read ?? readClaudeExport;
    this.scheduler = deps.scheduler ?? realScheduler;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? MEMORY_UPDATE_TIMEOUT_MS;
  }

  status(): ImportStatus {
    return structuredClone(this.current);
  }

  /** Resolves once the running job (if any) has finished. */
  idle(): Promise<void> {
    return this.job;
  }

  /** What importing `folder` would do. `profileId`, when given, is the import's profile, which memory falls back to. */
  async preview(folder: string, profileId: string | null = null): Promise<ImportPreview> {
    const read = await this.read(folder);
    const plan = planClaudeImport(read.files, { id: profileId ?? 'preview', connectionId: 'preview' });
    const { store } = this.deps;
    const projects = store.projects.list();
    const about = store.globalMemory.get().about;
    const model = await this.memoryProfile(profileId);
    return {
      folder,
      sources: read.sources,
      chats: {
        total: plan.chats.length,
        existing: plan.chats.filter((c) => store.chats.get(c.id) !== null).length,
        messages: plan.stats.messages,
        branched: plan.stats.branchedChats,
      },
      emptyChats: plan.stats.emptyConversations + plan.stats.malformedConversations,
      artifacts: plan.artifactChats.map((c) => ({ title: c.title, versions: c.artifact?.versions.length ?? 0, existing: store.chats.get(c.id) !== null })),
      projects: plan.projects.map((p) => {
        const byId = projects.find((x) => x.id === p.id);
        const byName = projects.find((x) => sameName(x.name, p.name));
        return {
          name: p.name,
          action: byId ? 'existing' : byName ? 'merge' : 'create',
          mergeInto: byId ? null : (byName?.name ?? null),
          docs: p.docs.length,
          hasInstructions: p.instructions.length > 0,
          hasMemory: p.memory.length > 0,
        };
      }),
      projectsSkipped: plan.stats.projectsSkipped,
      memory: {
        about: plan.memory.about.length > 0,
        aboutTaken: about.trim().length > 0,
        note: plan.memory.note.length > 0,
        projectNotes: plan.projects.filter((p) => p.memory.length > 0).length,
        files: plan.memory.files.length,
      },
      memoryModel: model?.name ?? null,
      filesNotIncluded: plan.stats.filesNotIncluded,
      dropped: plan.stats.dropped,
      importFolder: this.deps.importRoot,
    };
  }

  /**
   * Reads the export and starts the import in the background, returning its
   * first status. Throws `ImportBusyError`, `ImportInputError`, or the
   * reader's `ClaudeExportError` before anything is written.
   */
  async start(input: { folder: string; profileId: string; memory: boolean }): Promise<ImportStatus> {
    if (this.busy) throw new ImportBusyError();
    this.busy = true;
    let plan: ImportPlan;
    let profile: Profile;
    try {
      profile = this.checkProfile(input.profileId);
      const read = await this.read(input.folder);
      plan = planClaudeImport(read.files, { id: profile.id, connectionId: profile.connectionId });
    } catch (err) {
      this.busy = false;
      throw err;
    }
    const memorySteps = input.memory ? 2 + plan.projects.filter((p) => p.memory.length > 0).length : 0;
    this.current = {
      state: 'running',
      phase: 'chats',
      done: 0,
      total: plan.chats.length + plan.artifactChats.length + plan.projects.length + memorySteps,
      startedAt: this.now(),
      finishedAt: null,
      report: null,
      error: null,
    };
    this.job = this.run(plan, profile.id, input.memory).finally(() => {
      this.busy = false;
    });
    return this.status();
  }

  /** Stops memory calls in flight; the job stops at its next step. */
  dispose(): void {
    this.disposed = true;
    for (const stop of [...this.running]) stop();
  }

  private checkProfile(profileId: string): Profile {
    const profile = this.deps.store.profiles.get(profileId);
    if (!profile) throw new ImportInputError(`Profile "${profileId}" not found.`);
    if (profile.archivedAt !== null) throw new ImportInputError(`Profile "${profile.name}" is archived.`);
    return profile;
  }

  /** The Memory model setting, then the import's profile, then the app default (spec §4). */
  private memoryProfile(importProfileId: string | null): Promise<ResolvedProfile | null> {
    const { store, resolveProfile } = this.deps;
    const chosen = store.settings.get().memoryProfileId;
    return pickMemoryProfile(store, resolveProfile, [chosen, importProfileId, appDefaultProfileId(store)], chosen);
  }

  private step(phase: ImportPhase): void {
    if (this.disposed) throw new Error('Grunt was shut down during the import.');
    this.current.phase = phase;
  }

  private tick(): void {
    this.current.done = Math.min(this.current.total, this.current.done + 1);
  }

  private async run(plan: ImportPlan, profileId: string, memory: boolean): Promise<void> {
    const report: ImportReport = {
      chats: { imported: 0, existing: 0, messages: 0, failed: [] },
      emptyChats: plan.stats.emptyConversations + plan.stats.malformedConversations,
      artifacts: { imported: 0, existing: 0, failed: [] },
      projects: { created: [], merged: [], existing: [], failed: [], skipped: plan.stats.projectsSkipped },
      docs: { written: 0, folders: [] },
      memory: null,
      memoryFiles: null,
      filesNotIncluded: plan.stats.filesNotIncluded,
      dropped: plan.stats.dropped,
      importFolder: this.deps.importRoot,
    };
    try {
      // The job starts on the next tick, so `start` always answers with it running.
      await breathe();
      let written = 0;
      for (const [phase, chats, into] of [
        ['chats', plan.chats, report.chats],
        ['artifacts', plan.artifactChats, report.artifacts],
      ] as const) {
        for (const chat of chats) {
          this.step(phase);
          try {
            if (this.writeChat(chat, profileId) === 'existing') {
              into.existing++;
            } else {
              into.imported++;
              if (into === report.chats) report.chats.messages += chat.messages.length;
            }
          } catch (err) {
            into.failed.push({ title: chat.title, error: errorMessage(err) });
          }
          this.tick();
          if (++written % CHATS_PER_BREATH === 0) await breathe();
        }
      }

      const targets: { planned: ImportedProject; project: Project }[] = [];
      for (const planned of plan.projects) {
        this.step('projects');
        try {
          targets.push({ planned, project: await this.writeProject(planned, report) });
        } catch (err) {
          report.projects.failed.push({ title: planned.name, error: errorMessage(err) });
        }
        this.tick();
      }

      if (plan.memory.files.length > 0) report.memoryFiles = await this.writeMemoryFiles(plan.memory.files);
      if (memory) {
        this.step('memory');
        report.memory = await this.condenseMemory(plan, targets, profileId);
      }

      this.current = { ...this.current, state: 'done', phase: null, done: this.current.total, finishedAt: this.now(), report };
    } catch (err) {
      this.current = { ...this.current, state: 'failed', phase: null, finishedAt: this.now(), report, error: errorMessage(err) };
    }
  }

  /** Writes one chat (and its artifact) in one transaction, or reports it's already there. */
  private writeChat(chat: ImportedChat, profileId: string): 'imported' | 'existing' {
    const { store } = this.deps;
    if (store.chats.get(chat.id)) return 'existing';
    let announced = false;
    try {
      store.transaction(() => {
        store.chats.create({
          id: chat.id,
          title: chat.title,
          profileId,
          headMessageId: null,
          pinned: false,
          archivedAt: null,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          // The memory sweeps start after the imported messages: the memory step condenses claude.ai's own notes instead.
          memoryCursor: chat.latestMessageId,
          globalMemoryCursor: chat.latestMessageId,
        });
        announced = true;
        for (const m of chat.messages) store.messages.create(m);
        const artifact = chat.artifact;
        if (artifact) {
          store.artifacts.create({ id: artifact.id, chatId: chat.id, slug: artifact.slug, kind: 'html', language: null, createdAt: chat.createdAt });
          let parent: string | null = null;
          for (const v of artifact.versions) {
            store.artifacts.addVersion({ id: v.id, artifactId: artifact.id, title: v.title, content: v.content, madeBy: 'model', messageId: chat.messages[0]?.id ?? null, parentVersionId: parent, createdAt: v.createdAt });
            parent = v.id;
          }
        }
        store.chats.update(chat.id, { headMessageId: chat.headMessageId, updatedAt: chat.updatedAt });
      });
    } catch (err) {
      // The chat was announced before the rollback took it away again.
      if (announced) this.deps.events?.emit({ type: 'chat-deleted', chatId: chat.id });
      throw err;
    }
    return 'imported';
  }

  private async importRoot(): Promise<string> {
    await mkdir(this.deps.importRoot, { recursive: true });
    return this.deps.importRoot;
  }

  /** Creates the project, or fills the empty fields of the one it matches (by id on a re-run, else by name), then writes its docs. */
  private async writeProject(planned: ImportedProject, report: ImportReport): Promise<Project> {
    const { store } = this.deps;
    const byId = store.projects.get(planned.id);
    const existing = byId ?? store.projects.list().find((p) => sameName(p.name, planned.name)) ?? null;
    let project: Project;
    if (!existing) {
      project = store.projects.create({
        id: planned.id,
        name: planned.name,
        description: planned.description,
        instructions: planned.instructions,
        workspace: null,
        defaultProfileId: null,
        createdAt: planned.createdAt,
        updatedAt: planned.updatedAt,
      });
      report.projects.created.push(project.name);
    } else {
      const patch: Partial<Project> = {};
      if (!existing.description.trim() && planned.description) patch.description = planned.description;
      if (!existing.instructions.trim() && planned.instructions) patch.instructions = planned.instructions;
      project = Object.keys(patch).length > 0 ? store.projects.update(existing.id, patch) : existing;
      (byId ? report.projects.existing : report.projects.merged).push(project.name);
    }
    if (planned.docs.length > 0) project = await this.writeDocs(project, planned, report);
    return project;
  }

  /** Writes the docs to the project's folder and attaches it read-only, unless it's attached already or the project has no room. */
  private async writeDocs(project: Project, planned: ImportedProject, report: ImportReport): Promise<Project> {
    const { store } = this.deps;
    const root = await this.importRoot();
    const folder = containPath(root, safeFileName(`${planned.name}-${planned.id.slice(0, 8)}`, planned.id.slice(0, 8)));
    await mkdir(folder, { recursive: true });
    for (const doc of planned.docs) {
      await writeFile(containPath(folder, doc.name), doc.content, 'utf8');
      report.docs.written++;
    }
    const self = store.nodes.self().id;
    const workspace = classifyPath(folder, self, store.locations.pathsForNode(self));
    const folders = project.folders ?? [];
    const already = folders.some((f) => sameWorkspace(f.workspace, workspace));
    const attached = already || folders.length < MAX_EXTRA_FOLDERS;
    report.docs.folders.push({ project: project.name, path: folder, attached });
    if (already || !attached) return project;
    return store.projects.update(project.id, { folders: [...folders, { workspace, access: 'read' }] });
  }

  /** Keeps every claude.ai memory file under `memory/`, at its own path made safe. */
  private async writeMemoryFiles(files: ImportPlan['memory']['files']): Promise<string> {
    const base = containPath(await this.importRoot(), 'memory');
    for (const f of files) {
      const segments = f.path.split('/').filter((s) => s.length > 0).map((s, i) => safeFileName(s, `part-${i + 1}`));
      const target = containPath(base, segments.join('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content, 'utf8');
    }
    return base;
  }

  private ask(model: ResolvedProfile, prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    return this.deps.queue.add(() =>
      askMemoryModel({ engine: this.deps.engine, scheduler: this.scheduler, now: this.now, timeoutMs: this.timeoutMs, running: this.running }, model, IMPORT_CHAT_ID, prompt)
    );
  }

  /** About you (only when blank), the learned note, and each project's note, each on its own: one failing doesn't stop the rest. */
  private async condenseMemory(plan: ImportPlan, targets: { planned: ImportedProject; project: Project }[], profileId: string): Promise<NonNullable<ImportReport['memory']>> {
    const { store } = this.deps;
    const withNotes = targets.filter((t) => t.planned.memory.length > 0);
    const model = await this.memoryProfile(profileId);
    if (!model) {
      const none = skipped('No model available for memory.');
      return { model: null, about: none, note: none, projects: withNotes.map((t) => ({ name: t.project.name, outcome: none })) };
    }

    let about: MemoryOutcome;
    if (!plan.memory.about) about = skipped('The export has no notes about you.');
    else if (store.globalMemory.get().about.trim()) about = skipped('About you already has text, so it was left as it is.');
    else {
      const answer = await this.ask(model, importAboutPrompt(plan.memory.about));
      const checked = answer.ok ? finaliseImportedAbout(answer.text) : null;
      if (!answer.ok) about = failed(answer.error);
      else if (!checked!.ok) about = failed(checked!.reason);
      else if (store.globalMemory.get().about.trim()) about = skipped('About you was written while the import ran, so it was left as it is.');
      else {
        store.globalMemory.saveAbout(checked!.about, this.now());
        about = { status: 'saved' };
      }
    }
    this.step('memory');
    this.tick();

    let note: MemoryOutcome;
    if (!plan.memory.note) note = skipped('The export has no notes for the learned note.');
    else {
      const before = store.globalMemory.get().note;
      const current = before || emptyGlobalMemoryBody();
      const answer = await this.ask(model, importGlobalNotePrompt(current, plan.memory.note));
      const checked = answer.ok ? finaliseGlobalSummary(current, answer.text) : null;
      if (!answer.ok) note = failed(answer.error);
      else if (!checked!.ok) note = failed(checked!.reason);
      else if (!hasMemoryContent(checked!.body, GLOBAL_MEMORY_HEADINGS)) note = skipped(NOTHING_TO_KEEP);
      else if (store.globalMemory.get().note !== before) note = skipped('The learned note changed while the import ran, so it was left as it is.');
      else {
        store.globalMemory.saveNote(checked!.body, 'summariser', null, this.now());
        note = { status: 'saved' };
      }
    }
    this.step('memory');
    this.tick();

    const projects: { name: string; outcome: MemoryOutcome }[] = [];
    for (const { planned, project } of withNotes) {
      const before = store.projectMemory.get(project.id)?.body ?? null;
      const current = before ?? emptyMemoryBody();
      const answer = await this.ask(model, importProjectNotePrompt(project.name, current, planned.memory));
      const checked = answer.ok ? finaliseSummary(current, answer.text) : null;
      let outcome: MemoryOutcome;
      if (!answer.ok) outcome = failed(answer.error);
      else if (!checked!.ok) outcome = failed(checked!.reason);
      else if (!hasMemoryContent(checked!.body, MEMORY_HEADINGS)) outcome = skipped(NOTHING_TO_KEEP);
      else if ((store.projectMemory.get(project.id)?.body ?? null) !== before) outcome = skipped("The project's note changed while the import ran, so it was left as it is.");
      else {
        store.projectMemory.save(project.id, checked!.body, 'summariser', null, this.now());
        outcome = { status: 'saved' };
      }
      projects.push({ name: project.name, outcome });
      this.step('memory');
      this.tick();
    }
    return { model: model.name, about, note, projects };
  }
}
