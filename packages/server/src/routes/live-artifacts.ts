import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { buildLiveArgs, liveCallHash } from '@grunt/core/domain/live-artifacts.js';
import type { Artifact, ArtifactVersion, Chat, LiveSpec } from '@grunt/core/ports/store.js';
import type { LiveCallStatus, LiveStatusRequest } from '@grunt/core/ports/tool-provider.js';
import type { Profile } from '@grunt/core/types/config.js';
import type { Container } from '../container.js';
import { artifactOrThrow, requireJson } from './artifacts.js';

/** How long one live call may take, the request included (spec 2026-10-12-live-artifacts). */
const LIVE_CALL_TIMEOUT_MS = 30_000;

type LiveVersion = ArtifactVersion & { live: LiveSpec };

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Live artifact routes (spec 2026-10-12-live-artifacts), mounted at the
 * authed root next to artifactsRoutes: a live version's call status, allow,
 * stop, and one call. The page itself never reaches these: it has an opaque
 * origin and no token, and the app frame relays for it. Writes are JSON-only
 * and pass refuseCrossSiteWrites like every write. Not on the peer listener,
 * and never forwarded: calls run on this machine with its MCP servers and
 * grants.
 */
export function liveArtifactsRoutes(container: Container): Hono {
  const app = new Hono();
  const store = container.store;

  const liveVersion = (chatId: string, artifactId: string, versionId: string): { chat: Chat; artifact: Artifact; version: LiveVersion; profile: Profile } => {
    const { chat, artifact } = artifactOrThrow(container, chatId, artifactId);
    const version = store.artifacts.getVersion(versionId);
    if (!version || version.artifactId !== artifact.id) throw new HTTPException(404, { message: 'Version not found.' });
    if (version.kind !== 'html' || version.live === null) throw new HTTPException(409, { message: "This version doesn't ask for live data." });
    const profile = store.profiles.get(chat.profileId);
    if (!profile) throw new HTTPException(409, { message: "This chat's profile is gone, so its live data can't run." });
    return { chat, artifact, version: version as LiveVersion, profile };
  };

  const statusRequest = (chat: Chat, artifact: Artifact, version: LiveVersion, profile: Profile): LiveStatusRequest => ({
    chatId: chat.id,
    profileId: profile.id,
    policy: profile.toolPolicy,
    artifactId: artifact.id,
    calls: version.live.calls.map((call) => ({ call, hash: liveCallHash(call) })),
  });

  const view = (chat: Chat, version: LiveVersion, profile: Profile, statuses: LiveCallStatus[]) => {
    const self = store.nodes.self();
    const runsOn = chat.runsOn !== self.id ? { id: chat.runsOn, name: store.peers.get(chat.runsOn)?.name ?? chat.runsOn } : null;
    return {
      machine: { id: self.id, name: self.name },
      runsOn,
      profile: { id: profile.id, name: profile.name },
      calls: statuses.map((s, i) => ({ ...s, args: version.live.calls[i]!.args, params: version.live.calls[i]!.params })),
    };
  };

  app.get('/chats/:id/artifacts/:artifactId/versions/:versionId/live', (c) => {
    const { chat, artifact, version, profile } = liveVersion(c.req.param('id'), c.req.param('artifactId'), c.req.param('versionId'));
    return c.json(view(chat, version, profile, container.toolProvider.liveStatus(statusRequest(chat, artifact, version, profile))));
  });

  app.post('/chats/:id/artifacts/:artifactId/versions/:versionId/live/allow', (c) => {
    requireJson(c);
    const { chat, artifact, version, profile } = liveVersion(c.req.param('id'), c.req.param('artifactId'), c.req.param('versionId'));
    return c.json(view(chat, version, profile, container.toolProvider.allowLive(statusRequest(chat, artifact, version, profile))));
  });

  app.delete('/chats/:id/artifacts/:artifactId/live', (c) => {
    requireJson(c);
    const { chat, artifact } = artifactOrThrow(container, c.req.param('id'), c.req.param('artifactId'));
    container.toolProvider.revokeLive(chat.id, artifact.id);
    return c.body(null, 204);
  });

  app.post('/chats/:id/artifacts/:artifactId/versions/:versionId/live/calls/:callId', async (c) => {
    requireJson(c);
    const { chat, artifact, version, profile } = liveVersion(c.req.param('id'), c.req.param('artifactId'), c.req.param('versionId'));
    const body: unknown = await c.req.json().catch(() => null);
    if (!isPlainObject(body)) throw new HTTPException(400, { message: 'Send {"params": {...}} as JSON.' });
    const { params, fresh } = body;
    const call = version.live.calls.find((x) => x.id === c.req.param('callId'));
    if (!call) throw new HTTPException(404, { message: 'This page declares no such call.' });
    // "params" is an object or absent: null, an array or a scalar is refused here rather than read as "all defaults".
    if (params !== undefined && !isPlainObject(params)) return c.json({ ok: false, code: 'bad_params', message: '"params" must be an object.' });
    // Everything the call runs with comes from the stored declaration; the request only picks parameter values within its bounds.
    const built = buildLiveArgs(call, params);
    if (!built.ok) return c.json({ ok: false, code: 'bad_params', message: built.message });
    // Audit rows point at the version's reply, which must be on this machine (audit.message_id is a foreign key).
    if (version.messageId === null || !store.messages.get(version.messageId)) {
      throw new HTTPException(409, { message: "This version's reply hasn't reached this machine yet. Try again in a moment." });
    }
    const outcome = await container.toolProvider.runLiveCall({
      chatId: chat.id,
      messageId: version.messageId,
      profileId: profile.id,
      policy: profile.toolPolicy,
      artifactId: artifact.id,
      callId: call.id,
      hash: liveCallHash(call),
      toolName: call.tool,
      args: built.args,
      fresh: fresh === true,
      signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(LIVE_CALL_TIMEOUT_MS)]),
    });
    return c.json(outcome);
  });

  return app;
}
