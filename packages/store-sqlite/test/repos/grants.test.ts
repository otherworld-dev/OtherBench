import { describe, it, expect } from 'vitest';
import type { Grant } from '@grunt/core/ports/store.js';
import { freshDb, seedChatChain } from '../helpers.js';
import { SqliteGrantRepo } from '../../src/repos/grants.js';

function makeGrant(over: Partial<Grant> & { id: string }): Grant {
  return {
    chatId: null,
    profileId: null,
    toolName: 'fs.read',
    source: 'fs',
    scope: 'chat',
    constraint: null,
    expiresAt: null,
    ...over,
  };
}

describe('SqliteGrantRepo', () => {
  it('create/get round-trips every field, including a nullable constraint JSON column', () => {
    const db = freshDb();
    seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
    const repo = new SqliteGrantRepo(db);

    repo.create(
      makeGrant({
        id: 'grant-a',
        chatId: 'chat-a',
        profileId: 'p1',
        toolName: 'fs.write',
        source: 'fs',
        scope: 'always',
        constraint: { pathPrefix: '/workspace' },
        expiresAt: 99999,
      })
    );

    expect(repo.get('grant-a')).toEqual({
      id: 'grant-a',
      chatId: 'chat-a',
      profileId: 'p1',
      toolName: 'fs.write',
      source: 'fs',
      scope: 'always',
      constraint: { pathPrefix: '/workspace' },
      expiresAt: 99999,
    });
    db.close();
  });

  it('list(chatId) filters grants by chat; list() with no arg returns all', () => {
    const db = freshDb();
    seedChatChain(db, { connectionId: 'c1', modelId: 'm1', profileId: 'p1', chatId: 'chat-a' });
    seedChatChain(db, { connectionId: 'c2', modelId: 'm2', profileId: 'p2', chatId: 'chat-b' });
    const repo = new SqliteGrantRepo(db);
    repo.create(makeGrant({ id: 'grant-a', chatId: 'chat-a' }));
    repo.create(makeGrant({ id: 'grant-b', chatId: 'chat-b' }));

    expect(repo.list('chat-a').map((g) => g.id)).toEqual(['grant-a']);
    expect(repo.list().map((g) => g.id).sort()).toEqual(['grant-a', 'grant-b']);
    db.close();
  });

  it('round-trips a shell-source grant distinctly from an fs-source one (grants are keyed on source too)', () => {
    const db = freshDb();
    const repo = new SqliteGrantRepo(db);
    repo.create(makeGrant({ id: 'grant-shell', toolName: 'run_command', source: 'shell' }));
    repo.create(makeGrant({ id: 'grant-mcp', toolName: 'run_command', source: 'mcp' }));
    expect(repo.get('grant-shell')).toMatchObject({ toolName: 'run_command', source: 'shell' });
    expect(repo.get('grant-mcp')).toMatchObject({ toolName: 'run_command', source: 'mcp' });
    db.close();
  });

  it('a grant with a null chatId (profile-scoped or global) round-trips', () => {
    const db = freshDb();
    const repo = new SqliteGrantRepo(db);
    repo.create(makeGrant({ id: 'grant-global', chatId: null, profileId: null }));
    expect(repo.get('grant-global')).toMatchObject({ chatId: null, profileId: null });
    db.close();
  });
});
