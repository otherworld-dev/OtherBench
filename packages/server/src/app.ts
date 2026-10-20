import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Container } from './container.js';
import { CodeRouteError } from './code/route-errors.js';
import { refuseCrossSiteWrites } from './cross-site.js';
import { corsAllowlist, hostCheck } from './desktop.js';
import { authGate, authRoutes } from './remote/auth.js';
import type { RemoteAccess } from './remote/index.js';
import { appsRoutes } from './routes/apps.js';
import { attachmentsRoutes } from './routes/attachments.js';
import { browserRoutes } from './routes/browser.js';
import { computerRoutes } from './routes/computer.js';
import { chatsRoutes, searchRoutes } from './routes/chats.js';
import { commandsRoutes } from './routes/commands.js';
import { eventsRoutes } from './routes/events.js';
import { fsRoutes } from './routes/fs.js';
import { connectionsRoutes } from './routes/connections.js';
import { healthRoutes } from './routes/health.js';
import { importRoutes } from './routes/import.js';
import { locationsRoutes, nodeRoutes } from './routes/locations.js';
import { forwardingRoutes } from './peer/forward.js';
import { changesOnlyFromTheDesktopApp } from './computer/desktop-only.js';
import { peersRoutes } from './routes/peers.js';
import { modelsRoutes } from './routes/models.js';
import { profilesRoutes } from './routes/profiles.js';
import { memoryRoutes } from './routes/memory.js';
import { projectsRoutes } from './routes/projects.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { schedulesRoutes } from './routes/schedules.js';
import { settingsRoutes } from './routes/settings.js';
import { mcpSignInRoutes, oauthRedirectUri } from './routes/mcp-sign-in.js';
import { oauthCallbackRoutes } from './routes/oauth-callback.js';
import { toolsRoutes } from './routes/tools.js';
import { turnsRoutes } from './routes/turns.js';
import { notesRoutes } from './routes/notes.js';
import { usageRoutes } from './routes/usage.js';
import { artifactsRoutes } from './routes/artifacts.js';
import { liveArtifactsRoutes } from './routes/live-artifacts.js';
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
   * `otherbench serve` is bound to loopback, which `cli.ts`'s security gate
   * enforces before this app is ever constructed for a non-loopback host.
   */
  token?: string | null;
  /**
   * Absolute path to the built `@otherbench/web` bundle's directory. When set,
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
  /**
   * Sign-in mode (`--public-url`, spec 2026-10-12-remote-access): the
   * password, sessions, limiter and public URLs. When set, `/api` also takes
   * the session cookie, the Host check also accepts the public hosts, and
   * `/view/` links only work from the address that made them. Unset (null)
   * in open and token modes, which behave exactly as before.
   */
  remote?: RemoteAccess | null;
  /**
   * The port the server actually bound, for MCP sign-in's redirect address
   * `http://127.0.0.1:<port>/oauth/callback` (spec 2026-10-12-mcp-oauth-design §5).
   * Unset (most tests): sign-in answers 503. In sign-in mode the redirect is
   * the first public origin instead, and this port is not used.
   */
  oauthCallbackPort?: () => number;
}

export function createApp(container: Container, options: AppOptions = {}): Hono {
  const app = new Hono();

  const remote = options.remote ?? null;
  const token = options.token ?? null;

  if (options.hostCheckPort) {
    app.use('*', hostCheck(options.hostCheckPort, remote?.publicHosts ?? []));
  }
  if (options.corsOrigins && options.corsOrigins.length > 0) {
    app.use('/api/*', corsAllowlist(options.corsOrigins));
  }
  // Every mode (Deck #897): browser mode has no token to stop another site's form.
  app.use('/api/*', refuseCrossSiteWrites([...(options.corsOrigins ?? []), ...(remote?.publicOrigins ?? [])]));

  app.route('/api', healthRoutes());
  // Sign-in, sign-out and what mode this is (every mode); before the gated routes.
  app.route('/api/auth', authRoutes({ token, remote }));

  // One store of viewer links per server (Deck #826): the authed route makes them, the open /view route serves them.
  const viewLinks = new ViewLinks();
  // Sign-in mode: a /view/ link only works from the address that made it.
  const clientOf = remote ? (c: Context): string => remote.clientAddress(c) ?? 'unknown' : undefined;

  const authed = new Hono();
  // Open mode (no token, no sign-in) mounts no gate, as before.
  if (token || remote) authed.use('*', authGate({ token, remote }));
  // While computer use may be in control of this machine, changes come only from the desktop app's own window
  // (its --cors-origin), never from a browser tab of OtherBench that a model with a browser grant could be using.
  authed.use('*', changesOnlyFromTheDesktopApp(container.computer, options.corsOrigins ?? []));
  authed.route('/connections', connectionsRoutes(container));
  authed.route('/models', modelsRoutes(container));
  authed.route('/profiles', profilesRoutes(container));
  authed.route('/chats', chatsRoutes(container));
  authed.route('/projects', projectsRoutes(container));
  // The Code tab's apps, and their git, issues and files (spec 2026-10-20-code-tab-design). User actions, not model
  // tools, so they never pass the PermissionBroker -- and for the same reason they are never on the peer listener
  // (peer/forward.ts): a paired machine must not be able to commit, push or comment from here.
  authed.route('/apps', appsRoutes(container));
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
  // Messages sent while a reply runs: after the forwarding handlers, so a chat on a paired machine holds them there.
  authed.route('/', notesRoutes(container));
  // A chat's slash menu: after the forwarding handlers, so a chat on a paired machine is asked there.
  authed.route('/', commandsRoutes(container));
  // memoryRoutes defines full paths under /projects/:id/memory and
  // /chats/:id/memory, so it also mounts at the authed root. No collisions:
  // projectsRoutes owns /projects and /projects/:id only.
  authed.route('/', memoryRoutes(container));
  authed.route('/', searchRoutes(container));
  // Artifacts (Deck #896): full paths under /chats/:id/artifacts; chatsRoutes
  // owns /chats/:id itself and nothing under /artifacts.
  authed.route('/', artifactsRoutes(container));
  // Live artifacts (spec 2026-10-12-live-artifacts): full paths under
  // /chats/:id/artifacts/:artifactId/.../live, none of which artifactsRoutes owns.
  authed.route('/', liveArtifactsRoutes(container));
  // The model's browser (spec 2026-10-12-model-browser-design §5): full paths
  // under /chats/:id/browser; nothing else owns them. Behind the auth gate and
  // the cross-site write check like the rest; never on the peer listener.
  authed.route('/', browserRoutes(container));
  // Computer use (spec 2026-10-12-computer-use-design section 7): POST /chats/:id/computer/stop, the
  // thread banner's Stop, and GET /computer/status, whether the tool can be offered here. Behind the
  // auth gate and the cross-site write check; never on the peer listener.
  authed.route('/', computerRoutes(container));
  authed.route('/usage', usageRoutes(container));
  authed.route('/schedules', schedulesRoutes(container));
  authed.route('/claude', claudeRoutes(container));
  authed.route('/import', importRoutes(container));
  // This machine's sandbox VM (spec 2026-10-12-sandbox-design). Never on the peer listener.
  authed.route('/sandbox', sandboxRoutes(container));
  authed.route('/view', viewRoutes(container, viewLinks, clientOf));
  authed.route('/events', eventsRoutes(container));
  authed.route('/fs', fsRoutes());
  // toolsRoutes, like turnsRoutes, defines full paths under several
  // different prefixes (/mcp-servers, /chats/:id/grants, /grants/:id,
  // /chats/:id/audit, /approvals/:id/resolve) rather than one fixed one, so
  // it also mounts at the authed app's own root. No path collisions with
  // chatsRoutes/turnsRoutes: those own /chats, /chats/:id, /chats/:id/messages,
  // /chats/:id/turns, /chats/:id/stream, /chats/:id/head, /messages/:id/cancel.
  authed.route('/', toolsRoutes(container));
  // MCP sign-in (spec 2026-10-12-mcp-oauth-design §5): full paths under /mcp-servers/:id/sign-in… and /mcp-servers/sign-in/redirect-uri. No collisions with toolsRoutes: GET /mcp-servers/:id matches two segments only.
  // In sign-in mode OtherBench's own port may speak only HTTPS, so the loopback http address wouldn't load: the redirect is the public origin (it passes the Host check, and works behind a trusted proxy).
  const publicOrigin = remote?.publicOrigins[0] ?? null;
  const redirectUri = (): string | null =>
    remote ? (publicOrigin ? `${publicOrigin}/oauth/callback` : null) : oauthRedirectUri(options.oauthCallbackPort?.());
  authed.route('/', mcpSignInRoutes(container, redirectUri));
  // attachmentsRoutes, like turnsRoutes/toolsRoutes, defines full paths under
  // two different prefixes (/chats/:id/attachments, /attachments/:id[/content])
  // rather than one fixed one, so it also mounts at the authed app's own
  // root. No path collisions with chatsRoutes/turnsRoutes/toolsRoutes: none
  // of those own /chats/:id/attachments or /attachments/*.
  authed.route('/', attachmentsRoutes(container));
  app.route('/api', authed);
  // Viewer links (Deck #826): no token, the id is the capability. Before the static UI, which would answer every other path.
  app.route('/view', viewServeRoutes(viewLinks, (link) => linkStillAllowed(container, link), container.store.artifacts, clientOf));

  // MCP sign-in's redirect lands here, in every mode: no token or session (the system browser has none), Host check still applies, its own headers. Before the static UI, which would answer every other path.
  app.route('/oauth', oauthCallbackRoutes(container));

  // Sign-in with --tls auto: the CA a device installs to trust OtherBench (spec §4). No sign-in needed:
  // it's public, and the device checks its fingerprint against what `otherbench serve` printed.
  const caDer = remote?.tls.mode === 'auto' ? remote.tls.caDer : undefined;
  if (caDer) {
    app.get('/otherbench-ca.crt', (c) =>
      c.body(new Uint8Array(caDer), 200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="otherbench-ca.crt"',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      })
    );
  }

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
      // The Code tab's failures add a machine-readable `code` (and git's stderr) beside the message (code/route-errors.ts).
      return c.json({ error: err.message, ...(err instanceof CodeRouteError ? err.extras() : {}) }, err.status);
    }
    console.error('[otherbench-server] unhandled error:', err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  return app;
}
