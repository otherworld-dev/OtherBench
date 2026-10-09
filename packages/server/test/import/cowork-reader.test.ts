import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCoworkRoot, findCoworkFolders, readCoworkSessions } from '../../src/import/cowork-reader.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'grunt-cowork-reader-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, content: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

/** A session laid out as Claude Desktop keeps it: metadata beside a folder holding the transcript. */
async function session(org: string, id: string, cli: string, transcript: string | null, extra: Record<string, unknown> = {}): Promise<void> {
  await put(`${org}/local_${id}.json`, JSON.stringify({ sessionId: `local_${id}`, cliSessionId: cli, title: id, ...extra }));
  if (transcript !== null) await put(`${org}/local_${id}/.claude/projects/C--some-folder/${cli}.jsonl`, transcript);
}

describe('readCoworkSessions', () => {
  it("reads each session's metadata and transcript, with its space from the spaces file", async () => {
    await session('acc/org', 's1', 'cli-1', '{"type":"user"}');
    await session('acc/org', 's2', 'cli-2', '{"type":"assistant"}');
    await put('acc/org/remote-session-spaces.json', JSON.stringify({ entries: [{ sessionId: 'local_s1', spaceId: 'space-1', folders: [], memoryEnabled: true }] }));
    await put('acc/org/cowork_settings.json', '{}');
    const sessions = await readCoworkSessions(root);
    expect(sessions.map((s) => [(s.meta as { title: string }).title, s.transcript, s.spaceId])).toEqual([
      ['s1', '{"type":"user"}', 'space-1'],
      ['s2', '{"type":"assistant"}', null],
    ]);
  });

  it('passes over a session without a transcript, with unreadable metadata, or with ids that would make a path', async () => {
    await session('acc/org', 's1', 'cli-1', null);
    await put('acc/org/local_bad.json', '{ not json');
    await session('acc/org', 's3', '../../escape', 'x');
    await session('acc/org', 's4', 'cli-4', 'kept');
    expect((await readCoworkSessions(root)).map((s) => s.transcript)).toEqual(['kept']);
  });

  it('is empty when the folder is not there', async () => {
    expect(await readCoworkSessions(join(root, 'missing'))).toEqual([]);
  });

  it('reads a copy of the folder from wherever it was put, and an organisation folder on its own', async () => {
    await session('laptop/local-agent-mode-sessions/acc/org', 's1', 'cli-1', 'from the laptop');
    expect((await readCoworkSessions(root)).map((s) => s.transcript)).toEqual(['from the laptop']);
    expect((await readCoworkSessions(join(root, 'laptop/local-agent-mode-sessions/acc/org'))).map((s) => s.transcript)).toEqual(['from the laptop']);
  });
});

describe('findCoworkFolders', () => {
  it('finds every folder holding session metadata, never looking inside a session or hidden folder', async () => {
    await session('acc/org-a', 's1', 'cli-1', 'x');
    await session('acc/org-b', 's2', 'cli-2', 'y');
    await put('acc/org-a/local_s1/nested/local_planted.json', '{}');
    await put('.hidden/local_s9.json', '{}');
    expect(await findCoworkFolders(root)).toEqual([join(root, 'acc/org-a'), join(root, 'acc/org-b')]);
  });

  it('looks five folders down at most', async () => {
    await put('1/2/3/4/5/local_s1.json', '{}');
    await put('a/b/c/d/e/f/local_s2.json', '{}');
    expect(await findCoworkFolders(root)).toEqual([join(root, '1/2/3/4/5')]);
  });
});

describe('defaultCoworkRoot', () => {
  it("is where Claude Desktop keeps Cowork sessions on each OS", () => {
    expect(defaultCoworkRoot({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'Claude', 'local-agent-mode-sessions'));
    expect(defaultCoworkRoot({}, 'darwin', '/Users/a')).toBe(join('/Users/a', 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'));
    expect(defaultCoworkRoot({}, 'linux', '/home/a')).toBe(join('/home/a', '.config', 'Claude', 'local-agent-mode-sessions'));
  });
});
