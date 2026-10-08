import { PROJECT_DESCRIPTION_MAX, PROJECT_INSTRUCTIONS_MAX, PROJECT_NAME_MAX } from '@grunt/core/domain/projects.js';
import type { Project } from '@grunt/core/ports/store.js';
import { folderPath } from '../../components/FolderList.js';
import { validateWorkspaceRoot } from '../../lib/workspaceRoot.js';
import type { CreateProjectBody, FolderEntry, PatchProjectBody } from '../../state/api.js';

/**
 * The project page's form state (spec 2026-10-08-project-page-design §3) and
 * the API bodies it turns into. Pure: the page holds a draft, and only
 * Create/Save send anything.
 */

/** One other folder on the page: what the API is sent back, the path shown, and whether it isn't on this machine. */
export interface DraftFolder {
  entry: FolderEntry;
  display: string;
  away?: boolean;
}

export interface ProjectDraft {
  name: string;
  description: string;
  instructions: string;
  /** The main folder's path as typed; '' is none. */
  folder: string;
  folders: DraftFolder[];
  /** '' is App default. */
  defaultProfileId: string;
}

export function emptyDraft(): ProjectDraft {
  return { name: '', description: '', instructions: '', folder: '', folders: [], defaultProfileId: '' };
}

export function draftFromProject(project: Project): ProjectDraft {
  return {
    name: project.name,
    description: project.description,
    instructions: project.instructions,
    folder: project.workspaceRoot ?? '',
    folders: (project.folderViews ?? []).map((v) => ({ entry: { workspace: v.workspace, access: v.access }, display: folderPath(v), away: v.status.status !== 'ok' })),
    defaultProfileId: project.defaultProfileId ?? '',
  };
}

export function isDirty(initial: ProjectDraft, draft: ProjectDraft): boolean {
  return JSON.stringify(initial) !== JSON.stringify(draft);
}

/** The first thing to fix before sending, or null. The server is the hard gate; this is the early, friendlier check. */
export function draftProblem(draft: ProjectDraft, serverPlatform: string | null): string | null {
  const name = draft.name.trim();
  if (name.length === 0) return 'Give the project a name.';
  if (name.length > PROJECT_NAME_MAX) return `The name can be at most ${PROJECT_NAME_MAX} characters.`;
  if (draft.description.trim().length > PROJECT_DESCRIPTION_MAX) return `The description can be at most ${PROJECT_DESCRIPTION_MAX} characters.`;
  if (draft.instructions.length > PROJECT_INSTRUCTIONS_MAX) return `The instructions can be at most ${PROJECT_INSTRUCTIONS_MAX.toLocaleString('en-US')} characters.`;
  if (draft.folder.trim() !== '') return validateWorkspaceRoot(draft.folder, serverPlatform);
  return null;
}

function folderValue(folder: string): string | null {
  const trimmed = folder.trim();
  return trimmed === '' ? null : trimmed;
}

function entries(folders: DraftFolder[]): FolderEntry[] {
  return folders.map((f) => f.entry);
}

export function createBody(draft: ProjectDraft): CreateProjectBody {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions,
    workspaceRoot: folderValue(draft.folder),
    defaultProfileId: draft.defaultProfileId === '' ? null : draft.defaultProfileId,
    folders: entries(draft.folders),
  };
}

/** Only what changed since the page opened, so edits made elsewhere to other fields survive. */
export function patchBody(initial: ProjectDraft, draft: ProjectDraft): PatchProjectBody {
  const body: PatchProjectBody = {};
  if (draft.name !== initial.name) body.name = draft.name.trim();
  if (draft.description !== initial.description) body.description = draft.description.trim();
  if (draft.instructions !== initial.instructions) body.instructions = draft.instructions;
  if (folderValue(draft.folder) !== folderValue(initial.folder)) body.workspaceRoot = folderValue(draft.folder);
  if (draft.defaultProfileId !== initial.defaultProfileId) body.defaultProfileId = draft.defaultProfileId === '' ? null : draft.defaultProfileId;
  if (JSON.stringify(entries(draft.folders)) !== JSON.stringify(entries(initial.folders))) body.folders = entries(draft.folders);
  return body;
}
