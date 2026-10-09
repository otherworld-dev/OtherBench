import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ClaudeExportError } from '@grunt/core/domain/claude-import.js';
import type { Container } from '../container.js';
import { ImportBusyError, ImportInputError, type ClaudeImportService } from '../import/claude-import.js';
import { optionalBoolean, optionalNullableString, requireNonEmptyString } from '../validation.js';

interface ImportBody {
  folder?: unknown;
  profileId?: unknown;
  memory?: unknown;
}

/** The import's own refusals as 400s and 409s; anything else is a real failure. */
function asHttp(err: unknown): never {
  if (err instanceof ClaudeExportError || err instanceof ImportInputError) throw new HTTPException(400, { message: err.message });
  if (err instanceof ImportBusyError) throw new HTTPException(409, { message: err.message });
  throw err;
}

/**
 * Import from claude.ai (spec 2026-10-09-claude-import-design §5):
 * `POST /api/import/claude/preview { folder, profileId? }` says what importing
 * the export in `folder` would do, `POST /api/import/claude { folder,
 * profileId, memory? }` starts it (202) and `GET /api/import/claude` is the
 * running or last import's status.
 */
export function importRoutes(container: Container): Hono {
  const app = new Hono();

  const service = (): ClaudeImportService => {
    if (!container.claudeImport) throw new HTTPException(503, { message: "Importing isn't available on this server." });
    return container.claudeImport;
  };

  app.get('/claude', (c) => c.json(service().status()));

  app.post('/claude/preview', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ImportBody;
    const folder = requireNonEmptyString(body.folder, 'folder');
    const profileId = optionalNullableString(body.profileId, 'profileId') ?? null;
    try {
      return c.json(await service().preview(folder, profileId));
    } catch (err) {
      asHttp(err);
    }
  });

  app.post('/claude', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ImportBody;
    const folder = requireNonEmptyString(body.folder, 'folder');
    const profileId = requireNonEmptyString(body.profileId, 'profileId');
    const memory = optionalBoolean(body.memory, 'memory', true);
    try {
      return c.json(await service().start({ folder, profileId, memory }), 202);
    } catch (err) {
      asHttp(err);
    }
  });

  return app;
}
