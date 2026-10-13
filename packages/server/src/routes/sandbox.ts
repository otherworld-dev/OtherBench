import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { isSandboxError, type Sandbox } from '@grunt/core/ports/sandbox.js';
import { isAptPackageName, notAnAptPackageName } from '@grunt/sandbox/setup.js';
import type { Container } from '../container.js';

const MAX_PACKAGES = 50;

/** `PUT /api/sandbox/packages`'s list: trimmed, de-duplicated, each an apt package name by the one rule setup itself applies. */
export function parsePackages(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new HTTPException(400, { message: '"packages" must be an array of strings.' });
  }
  const packages = [...new Set(value.map((v) => v.trim()).filter((v) => v.length > 0))];
  if (packages.length > MAX_PACKAGES) throw new HTTPException(400, { message: `"packages" may list at most ${MAX_PACKAGES} packages.` });
  const bad = packages.find((p) => !isAptPackageName(p));
  if (bad !== undefined) throw new HTTPException(400, { message: notAnAptPackageName(bad) });
  return packages;
}

function sandboxOf(container: Container): Sandbox {
  if (!container.sandbox) throw new HTTPException(404, { message: 'This Grunt has no sandbox.' });
  return container.sandbox;
}

/** A SandboxError (busy, unsupported, ...) is a 409 with its message; a bad package name a 400. */
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isSandboxError(err)) throw new HTTPException(err.code === 'bad_package' ? 400 : 409, { message: err.message });
    throw err;
  }
}

/**
 * Settings > Sandbox (spec 2026-10-12-sandbox-design, "Setup"). Mounted on the
 * local API only, behind its auth, Host and cross-site checks: setting up or
 * removing this machine's VM is never something a paired machine can do.
 */
export function sandboxRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.json(await sandboxOf(container).status()));

  app.post('/setup', async (c) => {
    const sandbox = sandboxOf(container);
    const before = await sandbox.status();
    if (before.state === 'unsupported') throw new HTTPException(409, { message: before.detail ?? "The sandbox isn't available on this platform yet." });
    // One job at a time: while setup (or a package install) runs, this is the running one, not a second.
    if (before.state === 'setting_up') return c.json(before, 202);
    // A background job: the UI polls GET /api/sandbox for its progress.
    void sandbox.setup().catch((err: unknown) => console.error('[grunt-server] sandbox setup failed:', err));
    return c.json(await sandbox.status(), 202);
  });

  app.post('/remove', async (c) => {
    const sandbox = sandboxOf(container);
    await refusing(() => sandbox.remove());
    return c.json(await sandbox.status());
  });

  app.put('/packages', async (c) => {
    // Anything but a JSON object (a bad body, null, an array, a string) has no "packages".
    const raw: unknown = await c.req.json().catch(() => null);
    const body = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { packages?: unknown }) : {};
    const packages = parsePackages(body.packages);
    const sandbox = sandboxOf(container);
    await refusing(() => sandbox.setPackages(packages));
    return c.json(await sandbox.status(), 202);
  });

  return app;
}
