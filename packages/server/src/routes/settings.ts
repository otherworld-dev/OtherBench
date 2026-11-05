import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppSettings, Store } from '@otherbench/core/ports/store.js';
import type { Container } from '../container.js';
import { optionalNullableString } from '../validation.js';

interface SettingsBody {
  memoryProfileId?: unknown;
  githubEnabled?: unknown;
  nextcloudEnabled?: unknown;
  peerComputerControl?: unknown;
}

const FEATURES = ['githubEnabled', 'nextcloudEnabled'] as const;

/** Sets the Memory model back to "Project default" when `profileId` was it -- for a profile just archived or deleted. */
export function clearMemoryProfile(store: Store, profileId: string): void {
  if (store.settings.get().memoryProfileId === profileId) store.settings.update({ memoryProfileId: null });
}

/**
 * `GET/PATCH /api/settings`: app-wide settings (spec 2026-10-03-project-memory-design §4), GitHub and Nextcloud on or
 * off (`features.ts`), and whether paired machines may start and approve computer use here (`peerComputerControl`).
 * Not on the peer listener: only this machine's own UI changes them.
 */
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
    for (const key of FEATURES) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new HTTPException(400, { message: `"${key}" must be true or false.` });
      patch[key] = value;
    }
    // Whether paired machines may start and approve computer use here (peer/forward.ts reads it on every call).
    if (body.peerComputerControl !== undefined) {
      if (typeof body.peerComputerControl !== 'boolean') throw new HTTPException(400, { message: '"peerComputerControl" must be true or false.' });
      patch.peerComputerControl = body.peerComputerControl;
    }
    const before = container.store.settings.get();
    const after = container.store.settings.update(patch);
    if (before.peerComputerControl !== after.peerComputerControl && !FEATURES.some((key) => before[key] !== after[key])) {
      container.events?.emit({ type: 'settings-changed' });
    }
    if (FEATURES.some((key) => before[key] !== after[key])) {
      // Every window re-reads the settings, and the Overview drops or brings back its GitHub and Deck sections now.
      container.events?.emit({ type: 'settings-changed' });
      container.overview?.refresh().catch((err: unknown) => console.error('[otherbench-server] the overview check failed:', err));
    }
    return c.json(after);
  });

  return app;
}
