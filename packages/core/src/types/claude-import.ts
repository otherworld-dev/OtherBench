/**
 * Import from claude.ai (spec 2026-10-09-claude-import-design §5): what
 * `/api/import/claude` answers with, shared by the server and the web app.
 */

export type ImportPhase = 'reading' | 'chats' | 'artifacts' | 'projects' | 'memory';

export type MemoryOutcome = { status: 'saved' } | { status: 'skipped' | 'failed'; reason: string };

export interface ImportFailure {
  title: string;
  error: string;
}

export interface ImportPreview {
  folder: string;
  /** The files the conversations and memory were read from. */
  sources: string[];
  chats: { total: number; existing: number; messages: number; branched: number };
  /** Conversations with nothing in them, left out. */
  emptyChats: number;
  artifacts: { title: string; versions: number; existing: boolean }[];
  projects: { name: string; action: 'create' | 'merge' | 'existing'; mergeInto: string | null; docs: number; hasInstructions: boolean; hasMemory: boolean }[];
  projectsSkipped: number;
  memory: { about: boolean; aboutTaken: boolean; note: boolean; projectNotes: number; files: number };
  /** The profile that would condense memory, or null when none can. */
  memoryModel: string | null;
  filesNotIncluded: number;
  dropped: Record<string, number>;
  /** Where docs and claude.ai's memory files are written. */
  importFolder: string;
}

export interface ImportReport {
  chats: { imported: number; existing: number; messages: number; failed: ImportFailure[] };
  emptyChats: number;
  artifacts: { imported: number; existing: number; failed: ImportFailure[] };
  projects: { created: string[]; merged: string[]; existing: string[]; failed: ImportFailure[]; skipped: number };
  docs: { written: number; folders: { project: string; path: string; attached: boolean }[] };
  /** Null when memory was switched off. */
  memory: { model: string | null; about: MemoryOutcome; note: MemoryOutcome; projects: { name: string; outcome: MemoryOutcome }[] } | null;
  /** Where claude.ai's memory files were kept, or null when there were none. */
  memoryFiles: string | null;
  filesNotIncluded: number;
  dropped: Record<string, number>;
  importFolder: string;
}

export interface ImportStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  phase: ImportPhase | null;
  done: number;
  total: number;
  startedAt: number | null;
  finishedAt: number | null;
  report: ImportReport | null;
  error: string | null;
}
