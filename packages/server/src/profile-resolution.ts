import { HTTPException } from 'hono/http-exception';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { Container } from './container.js';
import { availableOn } from '@otherbench/core/domain/availability.js';

/**
 * Resolves a stored `Profile` into the `ResolvedProfile` a `ChatEngine`
 * request needs: its `Connection` row, decrypted API key (via `SecretStore`
 * -- never read from SQLite directly, per the global "API keys never in
 * SQLite" constraint), and matching `ModelInfo` row if one was ever
 * discovered/added for this connection (`profile.modelId` is free text --
 * see packages/store-sqlite/src/repos/profiles.ts -- so a match is not
 * guaranteed and `model: null` is a normal, valid outcome).
 *
 * Shared by routes/turns.ts (resolving the profiles a turn fans out to) and
 * routes/chats.ts (re-resolving the profile that produced a message, for
 * auto-title generation) -- both need the exact same assembly, and
 * duplicating it would risk the two drifting on how the API key gets
 * decrypted.
 */
export async function resolveProfile(container: Pick<Container, 'store' | 'secrets'>, profileId: string): Promise<ResolvedProfile> {
  const profile = container.store.profiles.get(profileId);
  if (!profile) throw new HTTPException(404, { message: `Profile "${profileId}" not found.` });

  const connection = container.store.connections.get(profile.connectionId);
  if (!connection) {
    throw new HTTPException(500, {
      message: `Profile "${profileId}" references connection "${profile.connectionId}", which no longer exists.`,
    });
  }

  // A connection bound to another machine (its Ollama, say) can't be reached from this one (v2 spec §5).
  const self = container.store.nodes.self().id;
  if (!availableOn(connection, self)) {
    const machine = container.store.peers.get(connection.availability ?? '')?.name ?? 'another machine';
    throw new HTTPException(409, { message: `Profile "${profile.name}" uses ${connection.name}, which only works on ${machine}. Run this chat there, or choose another profile.` });
  }

  const apiKey = connection.secretRef ? await container.secrets.get(connection.secretRef) : null;
  const model = container.store.models.list(profile.connectionId).find((m) => m.modelId === profile.modelId) ?? null;

  return { ...profile, connection, apiKey, model };
}

/**
 * The app default profile: the default unarchived profile, else the first
 * unarchived one, else null. The web client picks a new chat's profile the
 * same way.
 */
export function appDefaultProfileId(store: Store): string | null {
  const live = store.profiles.list().filter((p) => p.archivedAt === null);
  return (live.find((p) => p.isDefault) ?? live[0])?.id ?? null;
}
