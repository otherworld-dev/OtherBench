import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Container } from './container.js';
import { corsAllowlist, hostCheck } from './desktop.js';
import { attachmentsRoutes } from './routes/attachments.js';
import { chatsRoutes, searchRoutes } from './routes/chats.js';
import { eventsRoutes } from './routes/events.js';
import { fsRoutes } from './routes/fs.js';
import { connectionsRoutes } from './routes/connections.js';
import { healthRoutes } from './routes/health.js';
import { locationsRoutes, nodeRoutes } from './routes/locations.js';
import { forwardingRoutes } from './peer/forward.js';
import { peersRoutes } from './routes/peers.js';
import { modelsRoutes } from './routes/models.js';
import { profilesRoutes } from './routes/profiles.js';
import { memoryRoutes } from './routes/memory.js';
import { projectsRoutes } from './routes/projects.js';
import { settingsRoutes } from './routes/settings.js';
import { toolsRoutes } from './routes/tools.js';
import { turnsRoutes } from './routes/turns.js';
import { usageRoutes } from './routes/usage.js';
import { artifactsRoutes } from './routes/artifacts.js';
import { claudeRoutes } from './routes/claude.js';
import { viewRoutes } from './routes/view.js';
import { viewServeRoutes } from './routes/view-serve.js';
import { mountStatic } from './static.js';
import { ViewLinks } from './view/links.js';
import { linkStillAllowed } from './view/roots.js';

export interface AppOptions {
  /**
   * When set, every `/api/*` route EXCEPT `/api/health` requires
   * `Authorization: Bearer <token>` (see routes/health.ts for why health is
   * exempt). Unset means no auth is enforced at all -- safe only when
   * `grunt serve` is bound to loopback, which `cli.ts`'s security gate
   * enforces before this app is ever constructed for a non-loopback host.
   */
  token?: string | null;
  /**
   * Absolute path to the built `@grunt/web` bundle's directory. When set,
   * every non-`/api` path serves that app (or a placeholder if it hasn't
   * been built yet -- see static.ts). Unset (the default in tests) mounts
   * no static handling at all, so `/` is a plain 404 -- tests that only
   * exercise `/api/*` are unaffected either way.
   */
  webDistDir?: string;
  /**
   * Exact origins allowed to call `/api/*` cross-origin -- the desktop
   * shell's webview, which loads the bundled UI from its own origin rather
   * than from this server. Empty or unset mounts no CORS handling at all.
   */
  corsOrigins?: string[];
  /**
   * When set, every request must carry a loopback `Host` for this port (see
   * desktop.ts's `hostCheck`). `cli.ts` sets it whenever the bind host is
   * loopback; unset (tests, non-loopback binds) checks nothing.
   */
  hostCheckPort?: () => number;
}

export function createApp(container: Container, options: AppOptions = {}): Hono {
  const app = new Hono();

  if (options.hostCheckPort) {
    app.use('*', hostCheck(options.hostCheckPort));
  }
  if (options.corsOrigins && options.corsOrigins.length > 0) {
    app.use('/api/*', corsAllowlist(options.corsOrigins));
  }

  app.route('/api', healthRoutes());

  // One store of viewer links per server (Deck #826): the authed route makes them, the open /view route serves them.
  const viewLinks = new ViewLinks();

  const authed = new Hono();
  if (options.token) {
    const token = options.token;
    authed.use('*', async (c, next) => {
      const header = c.req.header('Authorization');
      if (header !== `Bearer ${token}`) {
        throw new HTTPException(401, { message: 'Missing or invalid bearer token.' });
      }
      await next();
    });
  }
  authed.route('/connections', connectionsRoutes(container));
  authed.route('/models', modelsRoutes(container));
  authed.route('/profiles', profilesRoutes(container));
  authed.route('/chats', chatsRoutes(container));
  authed.route('/projects', projectsRoutes(container));
  authed.route('/settings', settingsRoutes(container));
  authed.route('/locations', locationsRoutes(container));
  authed.route('/node', nodeRoutes(container));
  authed.route('/peers', peersRoutes(container));
  // turnsRoutes defines full paths under both /chats/... and /messages/...
  // (a turn spans both namespaces: POST .../turns, GET .../stream, POST
  // .../head live under /chats/:id/..., while POST .../cancel lives under
  // /messages/:id/...) so it mounts at the authed app's own root rather
  // than a single fixed prefix like the routers above. It has no path
  // collisions with chatsRoutes: that owns /chats, /chats/:id,
  // /chats/:id/messages; this owns /chats/:id/turns, /chats/:id/stream,
  // /chats/:id/head, /messages/:id/cancel.
  // A chat that runs on a paired machine is run there (Task 52): these
  // handlers forward its calls, and pass everything else on to the routes below.
  if (container.peers && container.remoteRuns) authed.route('/', forwardingRoutes(container, container.remoteRuns));
  authed.route('/', turnsRoutes(container));
  // memoryRoutes defines full paths under /projects/:id/memory and
  // /chats/:id/memory, so it also mounts at the authed root. No collisions:
  // projectsRoutes owns /projects and /projects/:id only.
  authed.route('/', memoryRoutes(container));
  authed.route('/', searchRoutes(container));
  // Artifacts (Deck #896): full paths under /chats/:id/artifacts; chatsRoutes
  // owns /chats/:id itself and nothing under /artifacts.
  authed.route('/', artifactsRoutes(container));
  authed.route('/usage', usageRoutes(container));
  authed.route('/claude', claudeRoutes(container));
  authed.route('/view', viewRoutes(container, viewLinks));
  authed.route('/events', eventsRoutes(container));
  authed.route('/fs', fsRoutes());
  // toolsRoutes, like turnsRoutes, defines full paths under several
  // different prefixes (/mcp-servers, /chats/:id/grants, /grants/:id,
  // /chats/:id/audit, /approvals/:id/resolve) rather than one fixed one, so
  // it also mounts at the authed app's own root. No path collisions with
  // chatsRoutes/turnsRoutes: those own /chats, /chats/:id, /chats/:id/messages,
  // /chats/:id/turns, /chats/:id/stream, /chats/:id/head, /messages/:id/cancel.
  authed.route('/', toolsRoutes(container));
  // attachmentsRoutes, like turnsRoutes/toolsRoutes, defines full paths under
  // two different prefixes (/chats/:id/attachments, /attachments/:id[/content])
  // rather than one fixed one, so it also mounts at the authed app's own
  // root. No path collisions with chatsRoutes/turnsRoutes/toolsRoutes: none
  // of those own /chats/:id/attachments or /attachments/*.
  authed.route('/', attachmentsRoutes(container));
  app.route('/api', authed);
  // Viewer links (Deck #826): no token, the id is the capability. Before the static UI, which would answer every other path.
  app.route('/view', viewServeRoutes(viewLinks, (link) => linkStillAllowed(container, link)));

  if (options.webDistDir) {
    mountStatic(app, { webDistDir: options.webDistDir });
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      // `err.getResponse()` (Hono's own default) returns the message as a
      // bare `text/plain` body when no `res` override was given -- every
      // validator in validation.ts throws exactly that shape. The web
      // client's `extractErrorMessage` (state/api.ts) only ever looks for a
      // JSON body with an `error` string field, falling back to
      // `res.statusText` (which is `''` for a manually-constructed
      // `Response`, per the fetch spec) when parsing fails -- so every
      // actionable validation message written anywhere in this codebase was
      // silently discarded client-side and replaced with a bare "HTTP 400"
      // before this. Wrapping it in the same `{error}` shape the 500
      // catch-all below already uses is what actually gets it in front of
      // the user.
      return c.json({ error: err.message }, err.status);
    }
    console.error('[grunt-server] unhandled error:', err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  return app;
}
