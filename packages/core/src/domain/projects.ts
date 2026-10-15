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

/** Finds a project by id: `store.projects.get` on the server, `projectLookup(list)` over a loaded list. */
export type ProjectLookup = (id: string) => Project | null | undefined;

export function projectLookup(projects: readonly Project[]): ProjectLookup {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return (id) => byId.get(id);
}

/**
 * The project `p` is a sub-project of, or null when it is top level (spec
 * 2026-10-15-sub-projects-design §2). `parentId` is a synced value, not a
 * promise: two machines can each make a legal move that together nests a
 * project under a sub-project, or under itself. So the parent counts only
 * when it exists, isn't `p`, and is top level itself; otherwise `p` is shown
 * and treated as top level until the next legal edit. Every reader goes
 * through this, so the prompt and the sidebar can't disagree.
 */
export function projectParentOf(p: Project, lookup: ProjectLookup): Project | null {
  const parentId = p.parentId ?? null;
  if (parentId === null || parentId === p.id) return null;
  const parent = lookup(parentId);
  if (!parent || (parent.parentId ?? null) !== null) return null;
  return parent;
}

/** "Parent / Child" for a sub-project, else the project's own name: how a project is named away from its own heading or page. */
export function projectDisplayName(p: Project, lookup: ProjectLookup): string {
  const parent = projectParentOf(p, lookup);
  return parent ? `${parent.name} / ${p.name}` : p.name;
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

/** `projectDisplayName` for the project with `id` in a loaded list, or undefined when it isn't there. */
export function projectDisplayNameById(projects: readonly Project[], id: string): string | undefined {
  const lookup = projectLookup(projects);
  const project = lookup(id);
  return project ? projectDisplayName(project, lookup) : undefined;
}
