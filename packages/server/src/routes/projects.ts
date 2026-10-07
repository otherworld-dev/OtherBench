import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PROJECT_DESCRIPTION_MAX, PROJECT_INSTRUCTIONS_MAX, PROJECT_NAME_MAX } from '@grunt/core/domain/projects.js';
import type { Project, Store } from '@grunt/core/ports/store.js';
import type { Container } from '../container.js';
import { optionalNullableString } from '../validation.js';
import { parseFoldersBody, parseWorkspaceBody, projectView, projectViews } from '../workspace-view.js';

interface ProjectBody {
  name?: unknown;
  workspace?: unknown;
  workspacePath?: unknown;
  workspaceRoot?: unknown;
  defaultProfileId?: unknown;
  sortOrder?: unknown;
  folders?: unknown;
  description?: unknown;
  instructions?: unknown;
}

/** Spec §2: trimmed, 1-80 characters. */
function requireProjectName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HTTPException(400, { message: '"name" is required and must be a string.' });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > PROJECT_NAME_MAX) {
    throw new HTTPException(400, { message: `"name" must be 1-${PROJECT_NAME_MAX} characters after trimming.` });
  }
  return trimmed;
}

/** Spec 2026-10-08-project-page-design §1: a string of at most `max` characters, or absent. */
function optionalProjectText(value: unknown, field: 'description' | 'instructions', max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new HTTPException(400, { message: `"${field}" must be a string.` });
  const text = field === 'description' ? value.trim() : value;
  if (text.length > max) throw new HTTPException(400, { message: `"${field}" must be at most ${max.toLocaleString('en-US')} characters.` });
  return text;
}

/** Spec §2: a default profile must exist and not be archived. */
function optionalDefaultProfileId(container: Container, value: unknown): string | null | undefined {
  const parsed = optionalNullableString(value, 'defaultProfileId');
  if (parsed === undefined || parsed === null) return parsed;
  const profile = container.store.profiles.get(parsed);
  if (!profile) throw new HTTPException(400, { message: `"defaultProfileId": profile "${parsed}" not found.` });
  if (profile.archivedAt !== null) {
    throw new HTTPException(400, { message: `"defaultProfileId": profile "${profile.name}" is archived.` });
  }
  return parsed;
}

function getProjectOrThrow(container: Container, id: string): Project {
  const project = container.store.projects.get(id);
  if (!project) throw new HTTPException(404, { message: `Project "${id}" not found.` });
  return project;
}

/**
 * Clears `profileId` as every project's default profile -- for a profile that
 * was just archived (spec §5). A deleted profile needs no call: the
 * `project.default_profile_id` foreign key is ON DELETE SET NULL.
 */
export function clearProjectDefaultProfile(store: Store, profileId: string): void {
  for (const project of store.projects.list()) {
    if (project.defaultProfileId === profileId) {
      store.projects.update(project.id, { defaultProfileId: null, updatedAt: Date.now() });
    }
  }
}

export function projectsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(projectViews(container, container.store.projects.list())));

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ProjectBody;
    // Every field is validated before anything is written.
    const name = requireProjectName(body.name);
    const workspace = parseWorkspaceBody(container, body) ?? null;
    const defaultProfileId = optionalDefaultProfileId(container, body.defaultProfileId) ?? null;
    const description = optionalProjectText(body.description, 'description', PROJECT_DESCRIPTION_MAX) ?? '';
    const instructions = optionalProjectText(body.instructions, 'instructions', PROJECT_INSTRUCTIONS_MAX) ?? '';
    const folders = parseFoldersBody(container, body.folders, [], workspace) ?? [];
    // New projects go to the bottom of the sidebar.
    const sortOrder = container.store.projects.list().reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1;

    const created = container.store.projects.create({ id: randomUUID(), name, description, instructions, workspace, folders, defaultProfileId, sortOrder });
    return c.json(projectView(container, created), 201);
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const current = getProjectOrThrow(container, id);
    const body = (await c.req.json().catch(() => ({}))) as ProjectBody;

    // Every field is validated before anything is written.
    const patch: Partial<Omit<Project, 'id'>> = {};
    if (body.name !== undefined) patch.name = requireProjectName(body.name);
    const workspace = parseWorkspaceBody(container, body);
    if (workspace !== undefined) patch.workspace = workspace;
    if (body.folders !== undefined) {
      patch.folders = parseFoldersBody(container, body.folders, current.folders ?? [], patch.workspace !== undefined ? patch.workspace : current.workspace);
    }
    if (body.defaultProfileId !== undefined) patch.defaultProfileId = optionalDefaultProfileId(container, body.defaultProfileId) ?? null;
    const description = optionalProjectText(body.description, 'description', PROJECT_DESCRIPTION_MAX);
    if (description !== undefined) patch.description = description;
    const instructions = optionalProjectText(body.instructions, 'instructions', PROJECT_INSTRUCTIONS_MAX);
    if (instructions !== undefined) patch.instructions = instructions;
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) {
        throw new HTTPException(400, { message: '"sortOrder" must be an integer.' });
      }
      patch.sortOrder = body.sortOrder;
    }
    patch.updatedAt = Date.now();

    return c.json(projectView(container, container.store.projects.update(id, patch)));
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    getProjectOrThrow(container, id);
    // Its chats move to No project (chat.project_id ON DELETE SET NULL);
    // streaming turns in them are unaffected. That happens inside the
    // database, past the chat repo, so announce each moved chat here.
    const moved = container.store.chats.list().filter((chat) => chat.projectId === id).map((chat) => chat.id);
    container.store.projects.delete(id);
    for (const chatId of moved) {
      const chat = container.store.chats.get(chatId);
      if (chat) container.events?.emit({ type: 'chat-updated', chat });
    }
    return c.body(null, 204);
  });

  return app;
}
