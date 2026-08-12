import { HTTPException } from 'hono/http-exception';
import type { ResolvedProfile } from '@grunt/core/types/config.js';
import type { Container } from './container.js';

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
export async function resolveProfile(container: Container, profileId: string): Promise<ResolvedProfile> {
  const profile = container.store.profiles.get(profileId);
  if (!profile) throw new HTTPException(404, { message: `Profile "${profileId}" not found.` });

  const connection = container.store.connections.get(profile.connectionId);
  if (!connection) {
    throw new HTTPException(500, {
      message: `Profile "${profileId}" references connection "${profile.connectionId}", which no longer exists.`,
    });
  }

  const apiKey = connection.secretRef ? await container.secrets.get(connection.secretRef) : null;
  const model = container.store.models.list(profile.connectionId).find((m) => m.modelId === profile.modelId) ?? null;

  return { ...profile, connection, apiKey, model };
}
