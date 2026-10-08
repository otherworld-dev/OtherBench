import type { Project } from '../ports/store.js';

/** Longest project name, after trimming (spec 2026-10-03-projects-design §2). */
export const PROJECT_NAME_MAX = 80;

/** Longest project description, after trimming (spec 2026-10-08-project-page-design §1). */
export const PROJECT_DESCRIPTION_MAX = 500;

/** Longest project instructions (spec 2026-10-08-project-page-design §1): bounds what every turn's prompt carries. */
export const PROJECT_INSTRUCTIONS_MAX = 8_000;

/** Folds A-Z only, exactly like SQLite's NOCASE collation, so both stores order names identically. */
function asciiFold(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * Sidebar order for projects: `sortOrder`, then name (ASCII case-insensitive),
 * then id. Mirrors `SqliteProjectRepo.list`'s
 * `ORDER BY sort_order, name COLLATE NOCASE, id`; the in-memory store and the
 * web client sort with this.
 */
export function compareProjects(a: Project, b: Project): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const an = asciiFold(a.name);
  const bn = asciiFold(b.name);
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The block a project chat's system prompt gets for the project's instructions
 * (spec 2026-10-08-project-page-design §2), or null when they're blank. The
 * user wrote them, so unlike project memory they are framed as instructions to
 * follow and not fenced off as untrusted background.
 */
export function projectInstructionsPrompt(projectName: string, instructions: string): string | null {
  const text = instructions.replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) return null;
  return `# Project instructions: ${projectName}\nInstructions from the user for every chat in this project. Follow them unless the user says otherwise in this chat.\n\n${text}`;
}
