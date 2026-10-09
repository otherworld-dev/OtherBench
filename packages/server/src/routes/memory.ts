import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { emptyProjectMemory, normaliseMemoryBody, validateMemoryBody, type MemoryVersionSummary, type ProjectMemoryView } from '@grunt/core/domain/memory.js';
import { emptyGlobalMemoryBody, normaliseGlobalMemoryBody, validateAbout, validateGlobalMemoryBody } from '@grunt/core/domain/global-memory.js';
import type { GlobalMemory, GlobalMemoryVersion, Project, ProjectMemoryVersion } from '@grunt/core/ports/store.js';
import type { Container } from '../container.js';

interface MemoryBody {
  body?: unknown;
}

/** What `GET /api/memory/global` and its writes return: a never-saved note reads as the empty note. */
function globalView(container: Container): { memory: GlobalMemory; lastError: ReturnType<NonNullable<Container['memory']>['lastGlobalError']> } {
  const memory = container.store.globalMemory.get();
  return { memory: { ...memory, note: memory.note || emptyGlobalMemoryBody() }, lastError: container.memory?.lastGlobalError() ?? null };
}

function getGlobalVersionOrThrow(container: Container, versionId: string): GlobalMemoryVersion {
  const version = container.store.globalMemory.version(versionId);
  if (!version) throw new HTTPException(404, { message: `Version "${versionId}" not found.` });
  return version;
}

function getProjectOrThrow(container: Container, id: string): Project {
  const project = container.store.projects.get(id);
  if (!project) throw new HTTPException(404, { message: `Project "${id}" not found.` });
  return project;
}

function getVersionOrThrow(container: Container, projectId: string, versionId: string): ProjectMemoryVersion {
  getProjectOrThrow(container, projectId);
  const version = container.store.projectMemory.version(versionId);
  if (!version || version.projectId !== projectId) throw new HTTPException(404, { message: `Version "${versionId}" not found.` });
  return version;
}

function view(container: Container, projectId: string): ProjectMemoryView {
  return {
    memory: container.store.projectMemory.get(projectId) ?? emptyProjectMemory(projectId),
    lastError: container.memory?.lastError(projectId) ?? null,
  };
}

/**
 * Project memory (spec 2026-10-03-project-memory-design §4). Full paths under
 * /projects/:id/memory and /chats/:id/memory, so this mounts at the authed
 * root like turnsRoutes; projectsRoutes and chatsRoutes own none of them.
 */
export function memoryRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/projects/:id/memory', (c) => c.json(view(container, getProjectOrThrow(container, c.req.param('id')).id)));

  app.put('/projects/:id/memory', async (c) => {
    const project = getProjectOrThrow(container, c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as MemoryBody;
    if (typeof body.body !== 'string') throw new HTTPException(400, { message: '"body" is required and must be a string.' });
    const problem = validateMemoryBody(body.body);
    if (problem) throw new HTTPException(400, { message: problem });
    // The user may edit Pinned; only the format and the cap are checked.
    const text = normaliseMemoryBody(body.body);
    if (container.store.projectMemory.get(project.id)?.body !== text) container.store.projectMemory.save(project.id, text, 'user', null);
    return c.json(view(container, project.id));
  });

  app.get('/projects/:id/memory/versions', (c) => {
    const project = getProjectOrThrow(container, c.req.param('id'));
    const versions: MemoryVersionSummary[] = container.store.projectMemory.versions(project.id).map((v) => ({
      id: v.id,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      sourceChatId: v.sourceChatId,
      length: v.body.length,
    }));
    return c.json(versions);
  });

  app.get('/projects/:id/memory/versions/:vid', (c) => c.json(getVersionOrThrow(container, c.req.param('id'), c.req.param('vid'))));

  app.post('/projects/:id/memory/versions/:vid/restore', (c) => {
    const version = getVersionOrThrow(container, c.req.param('id'), c.req.param('vid'));
    container.store.projectMemory.save(version.projectId, version.body, 'user', null);
    return c.json(view(container, version.projectId));
  });

  // Global memory (spec 2026-10-08-global-memory-design §3).
  app.get('/memory/global', (c) => c.json(globalView(container)));

  app.put('/memory/global/about', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { about?: unknown };
    if (typeof body.about !== 'string') throw new HTTPException(400, { message: '"about" is required and must be a string.' });
    const problem = validateAbout(body.about);
    if (problem) throw new HTTPException(400, { message: problem });
    if (container.store.globalMemory.get().about !== body.about) container.store.globalMemory.saveAbout(body.about);
    return c.json(globalView(container));
  });

  app.put('/memory/global', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as MemoryBody;
    if (typeof body.body !== 'string') throw new HTTPException(400, { message: '"body" is required and must be a string.' });
    const problem = validateGlobalMemoryBody(body.body);
    if (problem) throw new HTTPException(400, { message: problem });
    // The user may edit Pinned; only the format and the cap are checked.
    const text = normaliseGlobalMemoryBody(body.body);
    if (container.store.globalMemory.get().note !== text) container.store.globalMemory.saveNote(text, 'user', null);
    return c.json(globalView(container));
  });

  app.get('/memory/global/versions', (c) => {
    const versions: MemoryVersionSummary[] = container.store.globalMemory.versions().map((v) => ({
      id: v.id,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      sourceChatId: v.sourceChatId,
      length: v.body.length,
    }));
    return c.json(versions);
  });

  app.get('/memory/global/versions/:vid', (c) => c.json(getGlobalVersionOrThrow(container, c.req.param('vid'))));

  app.post('/memory/global/versions/:vid/restore', (c) => {
    const version = getGlobalVersionOrThrow(container, c.req.param('vid'));
    container.store.globalMemory.saveNote(version.body, 'user', null);
    return c.json(globalView(container));
  });

  app.post('/chats/:id/memory/update', async (c) => {
    const id = c.req.param('id');
    const chat = container.store.chats.get(id);
    if (!chat) throw new HTTPException(404, { message: `Chat "${id}" not found.` });
    if (chat.projectId === null || !container.store.projects.get(chat.projectId)) {
      throw new HTTPException(409, { message: "This chat isn't in a project." });
    }
    if (chat.memoryExcluded) throw new HTTPException(409, { message: 'This chat is set to not add to project memory.' });
    if (!container.memory) throw new HTTPException(503, { message: "Project memory isn't running on this server." });
    return c.json(await container.memory.updateNow(chat.id));
  });

  return app;
}
