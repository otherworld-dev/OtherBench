import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PROJECT_NAME_MAX } from '@grunt/core/domain/projects.js';
import type { Project, Store } from '@grunt/core/ports/store.js';
import type { Container } from '../container.js';
import { optionalNullableString, optionalWorkspaceRoot } from '../validation.js';

interface ProjectBody {
  name?: unknown;
  workspaceRoot?: unknown;
  defaultProfileId?: unknown;
  sortOrder?: unknown;
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

  app.get('/', (c) => c.json(container.store.projects.list()));

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ProjectBody;
    const name = requireProjectName(body.name);
    const workspaceRoot = optionalWorkspaceRoot(body.workspaceRoot, 'workspaceRoot') ?? null;
    const defaultProfileId = optionalDefaultProfileId(container, body.defaultProfileId) ?? null;
    // New projects go to the bottom of the sidebar.
    const sortOrder = container.store.projects.list().reduce((max, p) => Math.max(max, p.sortOrder), -1) + 1;

    const created = container.store.projects.create({ id: randomUUID(), name, workspaceRoot, defaultProfileId, sortOrder });
    return c.json(created, 201);
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    getProjectOrThrow(container, id);
    const body = (await c.req.json().catch(() => ({}))) as ProjectBody;

    // Every field is validated before anything is written.
    const patch: Partial<Omit<Project, 'id'>> = {};
    if (body.name !== undefined) patch.name = requireProjectName(body.name);
    if (body.workspaceRoot !== undefined) patch.workspaceRoot = optionalWorkspaceRoot(body.workspaceRoot, 'workspaceRoot') ?? null;
    if (body.defaultProfileId !== undefined) patch.defaultProfileId = optionalDefaultProfileId(container, body.defaultProfileId) ?? null;
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) {
        throw new HTTPException(400, { message: '"sortOrder" must be an integer.' });
      }
      patch.sortOrder = body.sortOrder;
    }
    patch.updatedAt = Date.now();

    return c.json(container.store.projects.update(id, patch));
  });

  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    getProjectOrThrow(container, id);
    // Its chats move to No project (chat.project_id ON DELETE SET NULL);
    // streaming turns in them are unaffected.
    container.store.projects.delete(id);
    return c.body(null, 204);
  });

  return app;
}
