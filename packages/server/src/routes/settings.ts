import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppSettings, Store } from '@otherbench/core/ports/store.js';
import type { Container } from '../container.js';
import { optionalNullableString } from '../validation.js';

interface SettingsBody {
  memoryProfileId?: unknown;
}

/** Sets the Memory model back to "Project default" when `profileId` was it -- for a profile just archived or deleted. */
export function clearMemoryProfile(store: Store, profileId: string): void {
  if (store.settings.get().memoryProfileId === profileId) store.settings.update({ memoryProfileId: null });
}

/** `GET/PATCH /api/settings`: app-wide settings (spec 2026-10-03-project-memory-design §4). */
export function settingsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(container.store.settings.get()));

  app.patch('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SettingsBody;
    // Every field is validated before anything is written.
    const patch: Partial<AppSettings> = {};
    if (body.memoryProfileId !== undefined) {
      const id = optionalNullableString(body.memoryProfileId, 'memoryProfileId') ?? null;
      if (id !== null) {
        const profile = container.store.profiles.get(id);
        if (!profile) throw new HTTPException(400, { message: `"memoryProfileId": profile "${id}" not found.` });
        if (profile.archivedAt !== null) throw new HTTPException(400, { message: `"memoryProfileId": profile "${profile.name}" is archived.` });
      }
      patch.memoryProfileId = id;
    }
    return c.json(container.store.settings.update(patch));
  });

  return app;
}
