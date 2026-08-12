import { describe, it, expect } from 'vitest';
import type { Profile, ToolPolicy } from '@grunt/core/types/config.js';
import { freshDb, seedConnectionAndModel } from '../helpers.js';
import { SqliteProfileRepo } from '../../src/repos/profiles.js';

function makeProfile(over: Partial<Profile> & { id: string; connectionId: string; modelId: string }): Profile {
  const toolPolicy: ToolPolicy = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' };
  return {
    name: 'Test Profile',
    description: null,
    colour: null,
    systemPrompt: null,
    params: {},
    toolPolicy,
    isDefault: false,
    archivedAt: null,
    ...over,
  };
}

describe('SqliteProfileRepo', () => {
  it('create/get round-trips nested JSON (params, toolPolicy)', () => {
    const db = freshDb();
    seedConnectionAndModel(db, { connectionId: 'conn-a', modelId: 'model-a' });
    const repo = new SqliteProfileRepo(db);

    repo.create(
      makeProfile({
        id: 'profile-a',
        connectionId: 'conn-a',
        modelId: 'model-a',
        name: 'My Profile',
        params: { temperature: 0.7, maxOutputTokens: 2048 },
        toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: ['mcp-1'], approvalMode: 'ask_on_mutate' },
        isDefault: true,
      })
    );

    expect(repo.get('profile-a')).toEqual({
      id: 'profile-a',
      name: 'My Profile',
      description: null,
      colour: null,
      connectionId: 'conn-a',
      modelId: 'model-a',
      systemPrompt: null,
      params: { temperature: 0.7, maxOutputTokens: 2048 },
      toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: ['mcp-1'], approvalMode: 'ask_on_mutate' },
      isDefault: true,
      archivedAt: null,
    });
    db.close();
  });

  it('accepts a modelId with no corresponding model row (free-text, no FK)', () => {
    const db = freshDb();
    seedConnectionAndModel(db, { connectionId: 'conn-a', modelId: 'model-a' });
    const repo = new SqliteProfileRepo(db);

    expect(() =>
      repo.create(makeProfile({ id: 'profile-a', connectionId: 'conn-a', modelId: 'never-discovered-model' }))
    ).not.toThrow();
    expect(repo.get('profile-a')?.modelId).toBe('never-discovered-model');
    db.close();
  });

  it('list returns every created profile', () => {
    const db = freshDb();
    seedConnectionAndModel(db, { connectionId: 'conn-a', modelId: 'model-a' });
    const repo = new SqliteProfileRepo(db);
    repo.create(makeProfile({ id: 'profile-a', connectionId: 'conn-a', modelId: 'model-a' }));
    repo.create(makeProfile({ id: 'profile-b', connectionId: 'conn-a', modelId: 'model-a' }));
    expect(repo.list().map((p) => p.id).sort()).toEqual(['profile-a', 'profile-b']);
    db.close();
  });
});
