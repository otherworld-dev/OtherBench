import { describe, it, expect } from 'vitest';
import type { Connection } from '@otherbench/core/types/config.js';
import { freshDb } from '../helpers.js';
import { SqliteConnectionRepo } from '../../src/repos/connections.js';

function makeConnection(over: Partial<Connection> & { id: string }): Connection {
  return {
    name: 'Test Connection',
    kind: 'mock',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
    ...over,
  };
}

describe('SqliteConnectionRepo', () => {
  it('create/get round-trips every field, including JSON extraHeaders', () => {
    const db = freshDb();
    const repo = new SqliteConnectionRepo(db);

    repo.create(
      makeConnection({
        id: 'conn-a',
        name: 'My Connection',
        kind: 'anthropic',
        baseUrl: 'https://api.example.com',
        secretRef: 'secret://conn-a',
        extraHeaders: { 'X-Custom': 'value' },
        status: 'ok',
        statusMessage: 'all good',
        checkedAt: 12345,
      })
    );

    expect(repo.get('conn-a')).toEqual({
      id: 'conn-a',
      name: 'My Connection',
      kind: 'anthropic',
      baseUrl: 'https://api.example.com',
      secretRef: 'secret://conn-a',
      extraHeaders: { 'X-Custom': 'value' },
      status: 'ok',
      statusMessage: 'all good',
      checkedAt: 12345,
      availability: 'anywhere',
      syncSecret: true,
    });
    db.close();
  });

  it('round-trips availability and keeping the key on this machine', () => {
    const db = freshDb();
    const repo = new SqliteConnectionRepo(db);
    repo.create(makeConnection({ id: 'conn-a', availability: 'node-pc', syncSecret: false }));
    expect(repo.get('conn-a')).toMatchObject({ availability: 'node-pc', syncSecret: false });
    repo.update('conn-a', { availability: 'anywhere', syncSecret: true });
    expect(repo.get('conn-a')).toMatchObject({ availability: 'anywhere', syncSecret: true });
    db.close();
  });

  it('get returns null for an unknown id', () => {
    const db = freshDb();
    const repo = new SqliteConnectionRepo(db);
    expect(repo.get('does-not-exist')).toBeNull();
    db.close();
  });

  it('list returns every created connection', () => {
    const db = freshDb();
    const repo = new SqliteConnectionRepo(db);
    repo.create(makeConnection({ id: 'conn-a' }));
    repo.create(makeConnection({ id: 'conn-b' }));
    expect(repo.list().map((c) => c.id).sort()).toEqual(['conn-a', 'conn-b']);
    db.close();
  });

  it('update patches fields and persists them', () => {
    const db = freshDb();
    const repo = new SqliteConnectionRepo(db);
    repo.create(makeConnection({ id: 'conn-a', name: 'Before' }));

    const updated = repo.update('conn-a', { name: 'After', status: 'error' });

    expect(updated.name).toBe('After');
    expect(updated.status).toBe('error');
    expect(repo.get('conn-a')?.name).toBe('After');
    db.close();
  });

  it('update throws when the id does not exist', () => {
    const db = freshDb();
    const repo = new SqliteConnectionRepo(db);
    expect(() => repo.update('does-not-exist', { name: 'x' })).toThrow(Error);
    db.close();
  });

  it('delete removes the row; a subsequent get returns null', () => {
    const db = freshDb();
    const repo = new SqliteConnectionRepo(db);
    repo.create(makeConnection({ id: 'conn-a' }));
    repo.delete('conn-a');
    expect(repo.get('conn-a')).toBeNull();
    db.close();
  });

  it('delete is an idempotent no-op on a missing id', () => {
    const db = freshDb();
    const repo = new SqliteConnectionRepo(db);
    expect(() => repo.delete('does-not-exist')).not.toThrow();
    db.close();
  });

  it('create throws on a duplicate id', () => {
    const db = freshDb();
    const repo = new SqliteConnectionRepo(db);
    repo.create(makeConnection({ id: 'conn-a' }));
    expect(() => repo.create(makeConnection({ id: 'conn-a' }))).toThrow(Error);
    db.close();
  });
});
