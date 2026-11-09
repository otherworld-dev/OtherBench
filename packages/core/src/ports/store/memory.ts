// --- project memory -----------------------------------------------------------

/** Who wrote a version of a project's memory note. */
export type MemoryAuthor = 'user' | 'summariser';

/**
 * A project's current memory note (spec 2026-10-03-project-memory-design §1).
 * `body` is markdown with the five fixed headings (`MEMORY_HEADINGS`).
 * `sourceChatId` is the chat the summariser folded in last, null for a user
 * save. A project that was never saved reads as `emptyProjectMemory()`
 * (`updatedAt: 0`).
 */
export interface ProjectMemory {
  projectId: string;
  body: string;
  updatedAt: number;
  updatedBy: MemoryAuthor;
  sourceChatId: string | null;
}

/** One saved version of a project's note; every save adds one. */
export interface ProjectMemoryVersion {
  id: string;
  projectId: string;
  body: string;
  createdAt: number;
  createdBy: MemoryAuthor;
  sourceChatId: string | null;
}

export interface ProjectMemoryRepo {
  /** The project's current note, or null if it has never been saved. */
  get(projectId: string): ProjectMemory | null;
  /**
   * Replaces the project's note, records it as a new version, and prunes the
   * project's versions beyond the newest `MEMORY_VERSIONS_KEPT` (ties on
   * `createdAt` break by save order). `at` defaults to now. Throws for a
   * project that doesn't exist.
   */
  save(projectId: string, body: string, by: MemoryAuthor, sourceChatId: string | null, at?: number): ProjectMemory;
  /** The project's versions, newest first. */
  versions(projectId: string): ProjectMemoryVersion[];
  version(id: string): ProjectMemoryVersion | null;
}

// --- global memory -----------------------------------------------------------------

/**
 * The user's global memory (spec 2026-10-08-global-memory-design): About you,
 * which the user writes, and the learned note the summariser keeps, each with
 * its last save. Never saved reads as '' with `*UpdatedAt: 0`.
 */
export interface GlobalMemory {
  about: string;
  aboutUpdatedAt: number;
  note: string;
  noteUpdatedAt: number;
  noteUpdatedBy: MemoryAuthor;
  noteSourceChatId: string | null;
}

/** One saved version of the learned note; every note save adds one. */
export interface GlobalMemoryVersion {
  id: string;
  body: string;
  createdAt: number;
  createdBy: MemoryAuthor;
  sourceChatId: string | null;
}

export interface GlobalMemoryRepo {
  get(): GlobalMemory;
  /** Replaces About you. `at` defaults to now. */
  saveAbout(about: string, at?: number): GlobalMemory;
  /** Replaces the learned note and records a version, keeping the newest `MEMORY_VERSIONS_KEPT`. `at` defaults to now. */
  saveNote(body: string, by: MemoryAuthor, sourceChatId: string | null, at?: number): GlobalMemory;
  /** The note's versions, newest first. */
  versions(): GlobalMemoryVersion[];
  version(id: string): GlobalMemoryVersion | null;
}
