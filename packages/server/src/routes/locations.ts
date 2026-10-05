import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { adoptIntoLocation, inferLocationMapping, relativeSegments } from '@grunt/core/domain/workspace.js';
import type { Location, LocationPath } from '@grunt/core/types/workspace.js';
import type { Container } from '../container.js';
import { optionalWorkspaceRoot, requireNonEmptyString } from '../validation.js';

/** The longest a location or machine name may be, after trimming. */
export const LOCATION_NAME_MAX = 80;

interface LocationBody {
  name?: unknown;
  path?: unknown;
}

interface NodeBody {
  name?: unknown;
}

interface InferBody {
  nodeId?: unknown;
  fromPath?: unknown;
  toPath?: unknown;
}

interface AdoptBody {
  locationId?: unknown;
  name?: unknown;
  nodeId?: unknown;
  fromRoot?: unknown;
  toRoot?: unknown;
}

/** A location as the API returns it: every machine's path for it. */
export interface LocationView extends Location {
  paths: LocationPath[];
}

function requireName(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new HTTPException(400, { message: `"name" is required and must be a string.` });
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > LOCATION_NAME_MAX) {
    throw new HTTPException(400, { message: `${what} name must be 1-${LOCATION_NAME_MAX} characters after trimming.` });
  }
  return trimmed;
}

/**
 * One location per name (ignoring case): two machines each adding "Nextcloud"
 * would otherwise make two, and a chat's folder in one wouldn't resolve on
 * the machine that set its path on the other.
 */
function assertNameFree(container: Container, name: string, except?: string): void {
  const clash = container.store.locations.list().find((l) => l.id !== except && l.name.toLowerCase() === name.toLowerCase());
  if (clash) {
    throw new HTTPException(409, { message: `There's already a location called ${clash.name}. Set this machine's folder for it instead of adding another.` });
  }
}

function getLocationOrThrow(container: Container, id: string): Location {
  const location = container.store.locations.get(id);
  if (!location) throw new HTTPException(404, { message: `Location "${id}" not found.` });
  return location;
}

function locationView(container: Container, location: Location): LocationView {
  return { ...location, paths: container.store.locations.paths(location.id) };
}

/**
 * Chats whose folder is in `locationId` resolve differently once its path on
 * this machine changes, so each is announced again (with its new view) for
 * open windows to pick up.
 */
function announceChatsIn(container: Container, locationId: string): void {
  for (const chat of container.store.chats.list()) {
    if (chat.workspace?.kind === 'location' && chat.workspace.locationId === locationId) {
      container.events?.emit({ type: 'chat-updated', chat });
    }
  }
}

/**
 * `/api/locations` (v2 plan, Task 43): named places each machine keeps at its
 * own path. This server only ever writes its own machine's path; other
 * machines' paths arrive by sync and are read-only here.
 */
export function locationsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(container.store.locations.list().map((l) => locationView(container, l))));

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as LocationBody;
    const name = requireName(body.name, 'A location');
    const path = optionalWorkspaceRoot(body.path, 'path') ?? null;
    assertNameFree(container, name);
    const location = container.store.locations.create({ id: randomUUID(), name });
    if (path !== null) container.store.locations.setPath({ locationId: location.id, nodeId: container.store.nodes.self().id, path });
    return c.json(locationView(container, location), 201);
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    getLocationOrThrow(container, id);
    const body = (await c.req.json().catch(() => ({}))) as LocationBody;
    let updated = getLocationOrThrow(container, id);
    if (body.name !== undefined) {
      const name = requireName(body.name, 'A location');
      assertNameFree(container, name, id);
      updated = container.store.locations.update(id, { name });
    }
    return c.json(locationView(container, updated));
  });

  /** This machine's path for the location; `{path: null}` removes it. */
  app.put('/:id/path', async (c) => {
    const id = c.req.param('id');
    const location = getLocationOrThrow(container, id);
    const body = (await c.req.json().catch(() => ({}))) as LocationBody;
    if (body.path === undefined) throw new HTTPException(400, { message: '"path" is required (null removes it).' });
    const path = optionalWorkspaceRoot(body.path, 'path') ?? null;
    const self = container.store.nodes.self().id;
    if (path === null) container.store.locations.deletePath(id, self);
    else container.store.locations.setPath({ locationId: id, nodeId: self, path });
    announceChatsIn(container, id);
    return c.json(locationView(container, location));
  });

  /**
   * What a folder on another machine (`fromPath`, on `nodeId`) and the same
   * folder chosen here (`toPath`) imply (v2 plan, Task 44): the location they
   * would share, an existing location that already matches it, and how many
   * chats and projects on that machine adopting it would move into it.
   */
  app.post('/infer', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as InferBody;
    const nodeId = requireNonEmptyString(body.nodeId, 'nodeId');
    const fromPath = requireNonEmptyString(body.fromPath, 'fromPath');
    const toPath = optionalWorkspaceRoot(body.toPath, 'toPath');
    if (!toPath) throw new HTTPException(400, { message: '"toPath" is required.' });
    const mapping = inferLocationMapping(fromPath, toPath);
    if (!mapping) return c.json({ mapping: null, existing: null, affected: 0 });
    const self = container.store.nodes.self().id;
    const samePath = (a: string, b: string): boolean => relativeSegments(a, b)?.length === 0;
    const matches = (p: LocationPath): boolean =>
      (p.nodeId === nodeId && samePath(p.path, mapping.fromRoot)) || (p.nodeId === self && samePath(p.path, mapping.toRoot));
    const existing = container.store.locations.list().find((l) => container.store.locations.paths(l.id).some(matches)) ?? null;
    const affected = [...container.store.chats.list(), ...container.store.projects.list()].filter(
      (x) => adoptIntoLocation(x.workspace, nodeId, mapping.fromRoot, 'probe') !== null
    ).length;
    return c.json({ mapping, existing, affected });
  });

  /**
   * Makes a location of a folder pair (`fromRoot` on `nodeId`, `toRoot` here)
   * -- a new one named `name`, or `locationId` -- and moves every chat and
   * project whose folder is on that machine under `fromRoot` into it. The
   * other machine's path is written here too: it's that machine's own folder,
   * read from its own chats, and without it the moved chats would stop
   * resolving there.
   */
  app.post('/adopt', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as AdoptBody;
    const nodeId = requireNonEmptyString(body.nodeId, 'nodeId');
    const fromRoot = requireNonEmptyString(body.fromRoot, 'fromRoot');
    const toRoot = optionalWorkspaceRoot(body.toRoot, 'toRoot');
    if (!toRoot) throw new HTTPException(400, { message: '"toRoot" is required.' });
    const self = container.store.nodes.self().id;
    if (nodeId === self) throw new HTTPException(400, { message: '"nodeId" must be another machine; for this one, set the location\'s path.' });
    const location =
      body.locationId !== undefined
        ? getLocationOrThrow(container, requireNonEmptyString(body.locationId, 'locationId'))
        : container.store.locations.create({ id: randomUUID(), name: requireName(body.name, 'A location') });
    container.store.locations.setPath({ locationId: location.id, nodeId: self, path: toRoot });
    container.store.locations.setPath({ locationId: location.id, nodeId, path: fromRoot });

    let converted = 0;
    for (const chat of container.store.chats.list()) {
      const workspace = adoptIntoLocation(chat.workspace, nodeId, fromRoot, location.id);
      if (workspace === null) continue;
      container.store.chats.update(chat.id, { workspace });
      converted++;
    }
    for (const project of container.store.projects.list()) {
      const workspace = adoptIntoLocation(project.workspace, nodeId, fromRoot, location.id);
      if (workspace === null) continue;
      container.store.projects.update(project.id, { workspace, updatedAt: Date.now() });
      converted++;
    }
    return c.json({ location: locationView(container, location), converted }, 201);
  });

  /** Chats and projects in it keep existing, without a folder. */
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    getLocationOrThrow(container, id);
    const affected = container.store.chats
      .list()
      .filter((chat) => chat.workspace?.kind === 'location' && chat.workspace.locationId === id)
      .map((chat) => chat.id);
    container.store.locations.delete(id);
    // The folder is cleared inside the database, past the chat repo, so announce each chat here.
    for (const chatId of affected) {
      const chat = container.store.chats.get(chatId);
      if (chat) container.events?.emit({ type: 'chat-updated', chat });
    }
    return c.body(null, 204);
  });

  return app;
}

/** `/api/node`: this machine's identity, and renaming it. */
export function nodeRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(container.store.nodes.self()));

  app.patch('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as NodeBody;
    return c.json(container.store.nodes.rename(requireName(body.name, "A machine's")));
  });

  return app;
}
