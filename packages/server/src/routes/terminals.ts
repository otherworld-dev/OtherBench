import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { TerminalStatus } from '@otherbench/core/types/terminal.js';
import type { Container } from '../container.js';
import { CodeRouteError } from '../code/route-errors.js';
import { STREAM_KEEPALIVE_MS, sseStream } from '../stream/sse.js';
import { TerminalError, type TerminalManager } from '../terminal/manager.js';
import { appRootOrThrow, getAppOrThrow } from './apps.js';

/** The most one input POST may carry (a big paste goes in pieces). */
export const TERMINAL_INPUT_MAX = 64 * 1024;
export const TERMINAL_NAME_MAX = 60;

/**
 * The Code tab's terminals (spec 2026-10-21-code-terminal-design). USER
 * actions on server routes, never model tools, so none of this passes the
 * PermissionBroker and none of it may ever be offered to a model. Mounted
 * (app.ts) only when this server is local -- open or token mode, bound to
 * loopback -- and never on the peer listener (peer/forward.ts's forwardedApi):
 * a shell here has no approval card. `GET /terminal/status` is always there,
 * so the web can tell why there's no Terminal tab.
 */
export function terminalStatusRoutes(container: Container, allowed: boolean): Hono {
  const app = new Hono();
  app.get('/terminal/status', async (c) => {
    const manager = container.terminals;
    let status: TerminalStatus;
    if (!allowed) status = { available: false, reason: 'not-local', shells: [] };
    else if (!manager || !(await manager.available())) status = { available: false, reason: 'no-pty', shells: [] };
    else status = { available: true, shells: manager.shellInfos() };
    return c.json(status);
  });
  return app;
}

/** A manager failure as the Code tab's routes answer one: `{ error, code }`, a 4xx. */
async function terminalCall<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TerminalError) {
      // shell-failed is this machine's state (a shell or folder gone), like the limit: a 409.
      const status = err.code === 'unknown-shell' ? 400 : err.code === 'no-terminal' ? 404 : 409;
      throw new CodeRouteError(status, err.code, err.message);
    }
    throw err;
  }
}

function requireSize(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new HTTPException(400, { message: `"${field}" must be a whole number from 1 to 1000.` });
  }
  return value;
}

async function bodyOf<T>(c: { req: { json(): Promise<unknown> } }): Promise<T> {
  return (await c.req.json().catch(() => ({}))) as T;
}

export function terminalsRoutes(container: Container): Hono {
  const app = new Hono();
  const managerOf = (): TerminalManager => {
    if (!container.terminals) throw new CodeRouteError(409, 'terminal-unavailable', "Terminals can't run on this machine.");
    return container.terminals;
  };
  /** The app's id, after checking it exists (404 otherwise). */
  const appIdOf = (raw: string): string => getAppOrThrow(container, raw).id;

  app.get('/apps/:id/terminals', (c) => c.json(managerOf().list(appIdOf(c.req.param('id')))));

  app.post('/apps/:id/terminals', async (c) => {
    const target = getAppOrThrow(container, c.req.param('id'));
    const body = await bodyOf<{ shell?: unknown; cols?: unknown; rows?: unknown }>(c);
    if (body.shell !== undefined && typeof body.shell !== 'string') throw new HTTPException(400, { message: '"shell" must be a shell id.' });
    const cols = requireSize(body.cols, 'cols');
    const rows = requireSize(body.rows, 'rows');
    const cwd = appRootOrThrow(container, target);
    const shellId = body.shell;
    const info = await terminalCall(() => managerOf().create(target.id, cwd, { ...(shellId !== undefined ? { shellId } : {}), cols, rows }));
    return c.json(info, 201);
  });

  app.patch('/apps/:id/terminals/:tid', async (c) => {
    const appId = appIdOf(c.req.param('id'));
    const { name } = await bodyOf<{ name?: unknown }>(c);
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (trimmed.length === 0 || trimmed.length > TERMINAL_NAME_MAX) {
      throw new HTTPException(400, { message: `"name" must be 1-${TERMINAL_NAME_MAX} characters after trimming.` });
    }
    return c.json(await terminalCall(() => managerOf().rename(appId, c.req.param('tid'), trimmed)));
  });

  app.delete('/apps/:id/terminals/:tid', async (c) => {
    const appId = appIdOf(c.req.param('id'));
    await terminalCall(() => managerOf().kill(appId, c.req.param('tid')));
    return c.body(null, 204);
  });

  app.post('/apps/:id/terminals/:tid/input', async (c) => {
    const appId = appIdOf(c.req.param('id'));
    const { data } = await bodyOf<{ data?: unknown }>(c);
    if (typeof data !== 'string') throw new HTTPException(400, { message: '"data" must be a string.' });
    if (data.length > TERMINAL_INPUT_MAX) throw new HTTPException(400, { message: `"data" is over ${TERMINAL_INPUT_MAX} characters; send it in pieces.` });
    await terminalCall(() => managerOf().input(appId, c.req.param('tid'), data));
    return c.body(null, 204);
  });

  app.post('/apps/:id/terminals/:tid/resize', async (c) => {
    const appId = appIdOf(c.req.param('id'));
    const body = await bodyOf<{ cols?: unknown; rows?: unknown }>(c);
    const cols = requireSize(body.cols, 'cols');
    const rows = requireSize(body.rows, 'rows');
    await terminalCall(() => managerOf().resize(appId, c.req.param('tid'), cols, rows));
    return c.body(null, 204);
  });

  /**
   * `?from=<offset>`: the output after an earlier answer's `next`, at once, for a page that has no connection to spare
   * for a stream (spec "One terminal stream per page, at most"). `reset` means start the screen again from `data`.
   */
  app.get('/apps/:id/terminals/:tid/output', async (c) => {
    const appId = appIdOf(c.req.param('id'));
    const raw = c.req.query('from') ?? '0';
    const from = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(from)) throw new HTTPException(400, { message: '"from" must be an offset from an earlier answer.' });
    return c.json(await terminalCall(() => managerOf().read(appId, c.req.param('tid'), from)));
  });

  app.post('/apps/:id/terminals/:tid/restart', async (c) => {
    const target = getAppOrThrow(container, c.req.param('id'));
    const cwd = appRootOrThrow(container, target);
    return c.json(await terminalCall(() => managerOf().restart(target.id, c.req.param('tid'), cwd)));
  });

  /**
   * The one terminal on screen (spec "One terminal stream per page, at most"): a `hello` with the replay buffer and
   * whether it has exited, then unnamed `{ type: 'output', data }` and `{ type: 'exit', exitCode }` records as they
   * happen (unnamed, as the web's SseClient reads a stream). Restarting keeps the stream: new output follows.
   */
  app.get('/apps/:id/terminals/:tid/stream', async (c) => {
    const appId = appIdOf(c.req.param('id'));
    const id = c.req.param('tid');
    const manager = managerOf();
    // Unknown terminal: a 404 before the stream starts.
    await terminalCall(() => manager.attach(appId, id, { onOutput: () => {}, onExit: () => {} }).detach());
    const keepaliveMs = container.streamTimings?.keepaliveMs ?? STREAM_KEEPALIVE_MS;
    return sseStream((sink) => {
      let attached: ReturnType<TerminalManager['attach']> | null = null;
      try {
        attached = manager.attach(appId, id, {
          onOutput: (data) => sink.send(null, { type: 'output', data }),
          onExit: (exitCode) => sink.send(null, { type: 'exit', exitCode }),
        });
        sink.send('hello', { buffer: attached.buffer, exitCode: attached.exitCode });
      } catch {
        // Closed between the check and now: end the stream, with nothing set going.
        sink.close();
        return () => {};
      }
      const keepalive = setInterval(() => sink.comment('keepalive'), keepaliveMs);
      return () => {
        clearInterval(keepalive);
        attached?.detach();
      };
    });
  });

  return app;
}
