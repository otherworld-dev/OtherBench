import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as breathe } from 'node:timers/promises';
import { chatListUrl, planClaudeImport, safeFileName, type ImportedChat, type ImportedProject, type ImportPlan } from '@grunt/core/domain/claude-import.js';
import { emptyCoworkStats, planCoworkSession, type CoworkChat, type CoworkSessionFiles } from '@grunt/core/domain/cowork-import.js';
import { finaliseImportedAbout, importAboutPrompt, importGlobalNotePrompt, importProjectNotePrompt } from '@grunt/core/domain/claude-import-memory.js';
import { emptyGlobalMemoryBody, finaliseGlobalSummary, GLOBAL_MEMORY_HEADINGS } from '@grunt/core/domain/global-memory.js';
import { emptyMemoryBody, finaliseSummary, hasMemoryContent, MEMORY_HEADINGS } from '@grunt/core/domain/memory.js';
import { containPath } from '@grunt/core/domain/paths.js';
import { classifyPath, MAX_EXTRA_FOLDERS, sameWorkspace } from '@grunt/core/domain/workspace.js';
import type { ChatEngine } from '@grunt/core/ports/chat-engine.js';
import type { Project, Store } from '@grunt/core/ports/store.js';
import type { AboutOutcome, CoworkPreview, ImportPhase, ImportPreview, ImportReport, ImportStart, ImportStatus, MemoryOutcome } from '@grunt/core/types/claude-import.js';
import type { Profile, ResolvedProfile } from '@grunt/core/types/config.js';
import { withPinnedSha } from '@grunt/store-sqlite/blob-gc.js';
import { sha256Of, type BlobStore, type StoredBlob } from '@grunt/store-sqlite/blob-store.js';
import { askMemoryModel, errorMessage, MEMORY_UPDATE_TIMEOUT_MS, pickMemoryProfile, type MemoryQueue } from '../memory/shared.js';
import { realScheduler, type Scheduler } from '../memory/scheduler.js';
import { appDefaultProfileId } from '../profile-resolution.js';
import type { AppEventBus } from '../stream/events.js';
import { readClaudeExport, type ClaudeExportRead } from './claude-reader.js';
import { readCoworkSessions } from './cowork-reader.js';

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
  /** Where pasted Cowork images are stored, as uploads are. Without it they become notes. */
  blobStore?: BlobStore;
  /** Where Claude Desktop keeps Cowork sessions on this machine; null or unset when there's nowhere to look. */
  coworkRoot?: string | null;
  readCowork?: (root: string) => Promise<CoworkSessionFiles[]>;
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
/** A docs folder is named `<project>-<first 8 of its id>`: the name is cut to leave room for the id. */
const FOLDER_NAME_MAX = 91;

const IDLE: ImportStatus = { state: 'idle', phase: null, done: 0, total: 0, startedAt: null, finishedAt: null, report: null, error: null };

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function skipped(reason: string): MemoryOutcome & AboutOutcome {
  return { status: 'skipped', reason };
}

function failed(reason: string): MemoryOutcome & AboutOutcome {
  return { status: 'failed', reason };
}

/** What happened to one chat: new, or already here (with messages it lacks or not), and whether it was put in a project. */
interface ChatOutcome {
  imported: boolean;
  newer: boolean;
  filed: boolean;
}

/** Pins every sha against blob GC until `fn` has finished (`withPinnedSha`, one inside another). */
function withPinnedShas<T>(shas: string[], fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = shas;
  return first === undefined ? fn() : withPinnedSha(first, () => withPinnedShas(rest, fn));
}

/** Whether an imported chat has messages in the export that it doesn't have here: added on claude.ai since the first import. */
function hasNewer(store: Store, chat: ImportedChat): boolean {
  return chat.messages.some((m) => store.messages.get(m.id) === null);
}

export class ClaudeImportService {
  private current: ImportStatus = IDLE;
  /** Set from the moment a start is accepted, before the export is read, so two starts can't both run. */
  private busy = false;
  private job: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly running = new Set<() => void>();
  private readonly read: (folder: string) => Promise<ClaudeExportRead>;
  private readonly readCowork: (root: string) => Promise<CoworkSessionFiles[]>;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ClaudeImportDeps) {
    this.read = deps.read ?? readClaudeExport;
    this.readCowork = deps.readCowork ?? readCoworkSessions;
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
    const others = this.otherProjects(plan);
    const about = store.globalMemory.get().about;
    const model = await this.memoryProfile(profileId);
    const existing = plan.chats.filter((c) => store.chats.get(c.id) !== null);
    const planned = new Set(plan.projects.map((p) => p.id));
    return {
      folder,
      sources: read.sources,
      chats: {
        total: plan.chats.length,
        existing: existing.length,
        newer: existing.filter((c) => hasNewer(store, c)).length,
        filed: plan.chats.filter((c) => c.projectId && (planned.has(c.projectId) || store.projects.get(c.projectId) !== null)).length,
        messages: plan.stats.messages,
        branched: plan.stats.branchedChats,
      },
      chatList: { found: plan.chatList, url: read.organizationId ? chatListUrl(read.organizationId) : null },
      cowork: await this.coworkPreview(profileId),
      emptyChats: plan.stats.emptyConversations + plan.stats.malformedConversations,
      artifacts: plan.artifactChats.map((c) => ({ title: c.title, versions: c.artifact?.versions.length ?? 0, existing: store.chats.get(c.id) !== null })),
      projects: plan.projects.map((p) => {
        const byId = projects.find((x) => x.id === p.id);
        const byName = others.find((x) => sameName(x.name, p.name));
        return {
          id: p.id,
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
      memoryChat: plan.memoryChat ? { title: plan.memoryChat.title, notes: plan.memoryChat.messages.length, existing: store.chats.get(plan.memoryChat.id) !== null } : null,
      memoryModel: model?.name ?? null,
      filesNotIncluded: plan.stats.filesNotIncluded,
      dropped: plan.stats.dropped,
      importFolder: this.deps.importRoot,
    };
  }

  /** The Cowork sessions on this machine, planned, or [] when there's nowhere to look or nothing there. */
  private async coworkChats(profile: { id: string; connectionId: string }): Promise<CoworkChat[]> {
    const root = this.deps.coworkRoot;
    if (!root) return [];
    const stats = emptyCoworkStats();
    return (await this.readCowork(root)).map((files) => planCoworkSession(files, profile, stats)).filter((c): c is CoworkChat => c !== null);
  }

  private async coworkPreview(profileId: string | null): Promise<CoworkPreview | null> {
    const chats = await this.coworkChats({ id: profileId ?? 'preview', connectionId: 'preview' });
    if (chats.length === 0 || !this.deps.coworkRoot) return null;
    const spaces = new Map<string, CoworkChat[]>();
    for (const chat of chats) if (chat.spaceId) spaces.set(chat.spaceId, [...(spaces.get(chat.spaceId) ?? []), chat]);
    return {
      root: this.deps.coworkRoot,
      sessions: chats.length,
      existing: chats.filter((c) => this.deps.store.chats.get(c.id) !== null).length,
      messages: chats.reduce((n, c) => n + c.messages.length, 0),
      images: chats.reduce((n, c) => n + c.images.length, 0),
      spaces: [...spaces].map(([id, inSpace]) => ({ id, sessions: inSpace.length, titles: inSpace.slice(0, 5).map((c) => c.title) })),
    };
  }

  /**
   * Reads the export (and, when asked, the Cowork sessions) and starts the
   * import in the background, returning its first status. Throws
   * `ImportBusyError`, `ImportInputError`, or the reader's
   * `ClaudeExportError` before anything is written.
   */
  async start(input: ImportStart): Promise<ImportStatus> {
    if (this.busy) throw new ImportBusyError();
    this.busy = true;
    let plan: ImportPlan;
    let profile: Profile;
    let cowork: CoworkChat[] | null = null;
    const spaces = input.spaces ?? {};
    try {
      profile = this.checkProfile(input.profileId);
      for (const projectId of Object.values(spaces)) {
        if (projectId !== null && !this.deps.store.projects.get(projectId)) throw new ImportInputError(`Project "${projectId}" not found.`);
      }
      const read = await this.read(input.folder);
      plan = planClaudeImport(read.files, { id: profile.id, connectionId: profile.connectionId });
      if (input.cowork) cowork = await this.coworkChats(profile);
    } catch (err) {
      this.busy = false;
      throw err;
    }
    const memorySteps = input.memory ? 2 + plan.projects.filter((p) => p.memory.length > 0).length : 0;
    this.current = {
      state: 'running',
      phase: 'projects',
      done: 0,
      total: plan.projects.length + plan.chats.length + plan.artifactChats.length + (plan.memoryChat ? 1 : 0) + (cowork?.length ?? 0) + memorySteps,
      startedAt: this.now(),
      finishedAt: null,
      report: null,
      error: null,
    };
    this.job = this.run(plan, profile.id, input.memory, cowork, spaces).finally(() => {
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

  /**
   * The projects an imported one may merge into by name: those already here
   * that the plan isn't itself bringing in, so two claude.ai projects with
   * one name don't merge into each other.
   */
  private otherProjects(plan: ImportPlan): Project[] {
    const planned = new Set(plan.projects.map((p) => p.id));
    return this.deps.store.projects.list().filter((p) => !planned.has(p.id));
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

  private async run(plan: ImportPlan, profileId: string, memory: boolean, cowork: CoworkChat[] | null, spaces: Record<string, string | null>): Promise<void> {
    const report: ImportReport = {
      chats: { imported: 0, existing: 0, newer: 0, filed: 0, messages: 0, failed: [] },
      cowork: cowork ? { imported: 0, existing: 0, filed: 0, messages: 0, images: 0, failed: [] } : null,
      emptyChats: plan.stats.emptyConversations + plan.stats.malformedConversations,
      artifacts: { imported: 0, existing: 0, failed: [] },
      projects: { created: [], merged: [], existing: [], failed: [], skipped: plan.stats.projectsSkipped },
      docs: { written: 0, folders: [] },
      fileErrors: [],
      memory: null,
      memoryFiles: null,
      memoryChat: null,
      filesNotIncluded: plan.stats.filesNotIncluded,
      dropped: plan.stats.dropped,
      importFolder: this.deps.importRoot,
    };
    try {
      // The job starts on the next tick, so `start` always answers with it running.
      await breathe();

      // Projects first, so a chat can be filed under its project as it's written.
      const targets: { planned: ImportedProject; project: Project }[] = [];
      const others = this.otherProjects(plan);
      for (const planned of plan.projects) {
        this.step('projects');
        try {
          targets.push({ planned, project: await this.writeProject(planned, others, report) });
        } catch (err) {
          report.projects.failed.push({ title: planned.name, error: errorMessage(err) });
        }
        this.tick();
      }
      // claude.ai's project ids to Grunt's: an imported project keeps its id, a merged one is the project it merged into.
      const projectFor = new Map(targets.map((t) => [t.planned.id, t.project.id]));
      const groundedProject = (claudeId: string | null | undefined): string | null =>
        claudeId ? (projectFor.get(claudeId) ?? (this.deps.store.projects.get(claudeId) ? claudeId : null)) : null;

      let written = 0;
      for (const [phase, chats, into] of [
        ['chats', plan.chats, report.chats],
        ['artifacts', plan.artifactChats, report.artifacts],
      ] as const) {
        for (const chat of chats) {
          this.step(phase);
          try {
            const outcome = this.writeChat(chat, profileId, groundedProject(chat.projectId));
            if (outcome.imported) {
              into.imported++;
              if (into === report.chats) report.chats.messages += chat.messages.length;
            } else {
              into.existing++;
              if (outcome.newer && into === report.chats) report.chats.newer++;
            }
            if (outcome.filed && into === report.chats) report.chats.filed++;
          } catch (err) {
            into.failed.push({ title: chat.title, error: errorMessage(err) });
          }
          this.tick();
          if (++written % CHATS_PER_BREATH === 0) await breathe();
        }
      }

      // claude.ai's memory notes, a chat of their own that recall searches.
      if (plan.memoryChat) {
        this.step('chats');
        const chat = plan.memoryChat;
        try {
          const outcome = this.writeChat(chat, profileId, null);
          report.memoryChat = { title: chat.title, notes: chat.messages.length, imported: outcome.imported };
        } catch (err) {
          report.chats.failed.push({ title: chat.title, error: errorMessage(err) });
        }
        this.tick();
      }

      for (const chat of cowork ?? []) {
        this.step('cowork');
        const into = report.cowork!;
        try {
          const target = chat.spaceId ? (spaces[chat.spaceId] ?? null) : null;
          const outcome = await this.writeCoworkChat(chat, profileId, target && this.deps.store.projects.get(target) ? target : null);
          if (outcome.imported) {
            into.imported++;
            into.messages += chat.messages.length;
            into.images += chat.images.length;
          } else {
            into.existing++;
          }
          if (outcome.filed) into.filed++;
        } catch (err) {
          into.failed.push({ title: chat.title, error: errorMessage(err) });
        }
        this.tick();
        if (++written % CHATS_PER_BREATH === 0) await breathe();
      }

      if (plan.memory.files.length > 0) report.memoryFiles = await this.writeMemoryFiles(plan.memory.files, report);
      if (memory) {
        this.step('memory');
        report.memory = await this.condenseMemory(plan, targets, profileId);
      }

      this.current = { ...this.current, state: 'done', phase: null, done: this.current.total, finishedAt: this.now(), report };
    } catch (err) {
      this.current = { ...this.current, state: 'failed', phase: null, finishedAt: this.now(), report, error: errorMessage(err) };
    }
  }

  /**
   * Writes one chat (and its artifact, and the attachment rows for images
   * already in the blob store) in one transaction, filed under `projectId`.
   * A chat already here is left as it is, except that one still in No
   * project is filed (the user's own filing is never undone); `newer` says
   * the export has messages it lacks, which a re-run doesn't add, so a chat
   * carried on in Grunt keeps its own branch.
   */
  private writeChat(chat: ImportedChat, profileId: string, projectId: string | null, images: { image: CoworkChat['images'][number]; blob: StoredBlob }[] = []): ChatOutcome {
    const { store } = this.deps;
    const existing = store.chats.get(chat.id);
    if (existing) {
      const newer = hasNewer(store, chat);
      if (existing.projectId !== null || projectId === null) return { imported: false, newer, filed: false };
      // Moving a chat into a project restarts its project memory; it starts after the imported messages, as a new import does.
      store.chats.update(chat.id, { projectId });
      store.chats.update(chat.id, { memoryCursor: store.messages.latestId(chat.id) });
      return { imported: false, newer, filed: true };
    }
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
          projectId,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          // The memory sweeps start after the imported messages: the memory step condenses claude.ai's own notes instead.
          memoryCursor: chat.latestMessageId,
          globalMemoryCursor: chat.latestMessageId,
        });
        announced = true;
        for (const m of chat.messages) store.messages.create(m);
        for (const { image, blob } of images) {
          store.attachments.create({ id: image.attachmentId, chatId: chat.id, messageId: image.messageId, filename: image.filename, mime: image.mime, size: blob.size, sha256: blob.sha256, storagePath: blob.path, extractedText: null });
        }
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
    return { imported: true, newer: false, filed: projectId !== null };
  }

  /**
   * A Cowork session's chat: its pasted images go into the blob store first,
   * pinned against blob GC until the rows naming them are written, as an
   * upload's are. Without a blob store they become notes.
   */
  private async writeCoworkChat(chat: CoworkChat, profileId: string, projectId: string | null): Promise<ChatOutcome> {
    const blobs = this.deps.blobStore;
    if (this.deps.store.chats.get(chat.id) || chat.images.length === 0) return this.writeChat(chat, profileId, projectId);
    if (!blobs) {
      const ids = new Set(chat.images.map((i) => i.attachmentId));
      const messages = chat.messages.map((m) => ({ ...m, parts: m.parts.map((p) => (p.type === 'image' && ids.has(p.attachmentId) ? { type: 'text' as const, text: '[An image, not imported]' } : p)) }));
      return this.writeChat({ ...chat, messages }, profileId, projectId);
    }
    const data = chat.images.map((image) => ({ image, bytes: Buffer.from(image.data, 'base64') }));
    return withPinnedShas([...new Set(data.map((d) => sha256Of(d.bytes)))], async () => {
      const stored: { image: CoworkChat['images'][number]; blob: StoredBlob }[] = [];
      for (const d of data) stored.push({ image: d.image, blob: await blobs.put(d.bytes) });
      return this.writeChat(chat, profileId, projectId, stored);
    });
  }

  private async importRoot(): Promise<string> {
    await mkdir(this.deps.importRoot, { recursive: true });
    return this.deps.importRoot;
  }

  /**
   * Creates the project, or fills the empty fields of the one it matches (by
   * id on a re-run, else by name among `others`), then writes its docs.
   */
  private async writeProject(planned: ImportedProject, others: Project[], report: ImportReport): Promise<Project> {
    const { store } = this.deps;
    const byId = store.projects.get(planned.id);
    const existing = byId ?? others.find((p) => sameName(p.name, planned.name)) ?? null;
    let project: Project;
    if (!existing) {
      project = store.projects.create({
        id: planned.id,
        name: planned.name,
        description: planned.description,
        instructions: planned.instructions,
        workspace: null,
        defaultProfileId: null,
        // After every project there is, as a project made in the sidebar goes.
        sortOrder: store.projects.list().reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1,
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

  /**
   * Writes the docs to the project's folder and attaches it read-only, unless
   * it's attached already or the project has no room. A doc that can't be
   * written is reported and the rest carry on.
   */
  private async writeDocs(project: Project, planned: ImportedProject, report: ImportReport): Promise<Project> {
    const { store } = this.deps;
    const root = await this.importRoot();
    const id8 = planned.id.slice(0, 8);
    const folder = containPath(root, `${safeFileName(planned.name, 'project', FOLDER_NAME_MAX)}-${id8}`);
    await mkdir(folder, { recursive: true });
    for (const doc of planned.docs) {
      try {
        await writeFile(containPath(folder, doc.name), doc.content, 'utf8');
        report.docs.written++;
      } catch (err) {
        report.fileErrors.push({ title: `${project.name}: ${doc.name}`, error: errorMessage(err) });
      }
    }
    // Read again: the folders may have changed in Settings while the files were written.
    const fresh = store.projects.get(project.id) ?? project;
    const self = store.nodes.self().id;
    const workspace = classifyPath(folder, self, store.locations.pathsForNode(self));
    const folders = fresh.folders ?? [];
    const already = folders.some((f) => sameWorkspace(f.workspace, workspace));
    const attached = already || folders.length < MAX_EXTRA_FOLDERS;
    report.docs.folders.push({ project: fresh.name, path: folder, attached, workspace: fresh.workspace !== null });
    if (already || !attached) return fresh;
    return store.projects.update(fresh.id, { folders: [...folders, { workspace, access: 'read' }] });
  }

  /** Keeps every claude.ai memory file under `memory/`, at its own path made safe. One that can't be written is reported. */
  private async writeMemoryFiles(files: ImportPlan['memory']['files'], report: ImportReport): Promise<string> {
    const base = containPath(await this.importRoot(), 'memory');
    for (const f of files) {
      try {
        const segments = f.path.split('/').filter((s) => s.length > 0).map((s, i) => safeFileName(s, `part-${i + 1}`));
        const target = containPath(base, segments.join('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, f.content, 'utf8');
      } catch (err) {
        report.fileErrors.push({ title: f.path, error: errorMessage(err) });
      }
    }
    return base;
  }

  private ask(model: ResolvedProfile, prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    return this.deps.queue.add(async () =>
      // A call still queued when Grunt shuts down never starts.
      this.disposed
        ? { ok: false as const, error: 'Grunt was shut down during the import.' }
        : askMemoryModel({ engine: this.deps.engine, scheduler: this.scheduler, now: this.now, timeoutMs: this.timeoutMs, running: this.running }, model, IMPORT_CHAT_ID, prompt)
    );
  }

  /**
   * About you (drafted for the user to accept, never saved here: it goes into
   * every chat as their own words), the learned note and each project's note,
   * each on its own: one failing doesn't stop the rest.
   */
  private async condenseMemory(plan: ImportPlan, targets: { planned: ImportedProject; project: Project }[], profileId: string): Promise<NonNullable<ImportReport['memory']>> {
    const { store } = this.deps;
    const withNotes = targets.filter((t) => t.planned.memory.length > 0);
    const model = await this.memoryProfile(profileId);
    if (!model) {
      const none = skipped('No model available for memory.');
      return { model: null, about: none, note: none, projects: withNotes.map((t) => ({ name: t.project.name, outcome: none })) };
    }

    let about: AboutOutcome;
    if (!plan.memory.about) about = skipped('The export has no notes about you.');
    else {
      const answer = await this.ask(model, importAboutPrompt(plan.memory.about));
      const checked = answer.ok ? finaliseImportedAbout(answer.text) : null;
      if (!answer.ok) about = failed(answer.error);
      else if (!checked!.ok) about = failed(checked!.reason);
      else about = { status: 'drafted', text: checked!.about };
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
