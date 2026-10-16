import { describe, expect, it } from 'vitest';
import { adoptIntoLocation, canReachFolders, classifyPath, extraFoldersPrompt, inferLocationMapping, joinSubpath, mergeFolders, parseFolders, relativeSegments, resolveFolders, resolveWorkspace, sameWorkspace } from '../src/domain/workspace.js';
import type { ExtraFolder, LocationPath } from '../src/types/workspace.js';

const PC = 'node-pc';
const LAPTOP = 'node-laptop';
const paths: LocationPath[] = [
  { locationId: 'nextcloud', nodeId: PC, path: 'E:\\Nextcloud' },
  { locationId: 'nextcloud', nodeId: LAPTOP, path: 'C:\\Users\\Adam\\Nextcloud' },
  { locationId: 'phd', nodeId: PC, path: 'E:\\Nextcloud\\phd' },
  { locationId: 'git', nodeId: PC, path: 'E:\\Git' },
  { locationId: 'home', nodeId: LAPTOP, path: '/home/adam' },
];
const all = (): boolean => true;
const none = (): boolean => false;

describe('classifyPath', () => {
  it('stores a folder inside a location of this machine as location-relative; the longest location wins', () => {
    expect(classifyPath('E:\\Nextcloud\\work\\notes', PC, paths)).toEqual({ kind: 'location', locationId: 'nextcloud', subpath: 'work/notes' });
    expect(classifyPath('E:\\Nextcloud\\phd\\thesis', PC, paths)).toEqual({ kind: 'location', locationId: 'phd', subpath: 'thesis' });
    expect(classifyPath('E:\\Git', PC, paths)).toEqual({ kind: 'location', locationId: 'git', subpath: '' });
  });

  it('ignores case and either separator for Windows paths, and never matches a sibling that merely starts the same', () => {
    expect(classifyPath('e:/nextcloud/Work', PC, paths)).toEqual({ kind: 'location', locationId: 'nextcloud', subpath: 'Work' });
    expect(classifyPath('E:\\Next', PC, paths)).toEqual({ kind: 'machine', nodeId: PC, root: 'E:\\Next' });
    expect(classifyPath('E:\\Nextcloudy\\x', PC, paths)).toEqual({ kind: 'machine', nodeId: PC, root: 'E:\\Nextcloudy\\x' });
  });

  it("only uses this machine's own location paths, and is case-sensitive for POSIX paths", () => {
    expect(classifyPath('C:\\Users\\Adam\\Nextcloud\\x', PC, paths)).toEqual({ kind: 'machine', nodeId: PC, root: 'C:\\Users\\Adam\\Nextcloud\\x' });
    expect(classifyPath('/home/adam/src', LAPTOP, paths)).toEqual({ kind: 'location', locationId: 'home', subpath: 'src' });
    expect(classifyPath('/home/Adam/src', LAPTOP, paths)).toEqual({ kind: 'machine', nodeId: LAPTOP, root: '/home/Adam/src' });
  });
});

describe('resolveWorkspace', () => {
  it('none, ok here, and a location-relative folder resolving with each machine its own path', () => {
    expect(resolveWorkspace(null, PC, paths, all)).toEqual({ status: 'none' });
    const ws = { kind: 'location' as const, locationId: 'nextcloud', subpath: 'phd/notes' };
    expect(resolveWorkspace(ws, PC, paths, all)).toEqual({ status: 'ok', root: 'E:\\Nextcloud\\phd\\notes' });
    expect(resolveWorkspace(ws, LAPTOP, paths, all)).toEqual({ status: 'ok', root: 'C:\\Users\\Adam\\Nextcloud\\phd\\notes' });
    expect(resolveWorkspace({ kind: 'machine', nodeId: PC, root: 'E:\\x' }, PC, paths, all)).toEqual({ status: 'ok', root: 'E:\\x' });
  });

  it('no path for the location here: says where it is elsewhere', () => {
    expect(resolveWorkspace({ kind: 'location', locationId: 'git', subpath: 'OtherBench' }, LAPTOP, paths, all)).toEqual({
      status: 'unresolved', reason: 'no-location-path', hint: { nodeId: PC, path: 'E:\\Git\\OtherBench' },
    });
    expect(resolveWorkspace({ kind: 'location', locationId: 'gone', subpath: '' }, PC, paths, all)).toEqual({ status: 'unresolved', reason: 'no-location-path' });
  });

  it("another machine's folder, and a folder that doesn't exist here", () => {
    expect(resolveWorkspace({ kind: 'machine', nodeId: PC, root: 'E:\\Git\\x' }, LAPTOP, paths, all)).toEqual({
      status: 'unresolved', reason: 'other-machine', hint: { nodeId: PC, path: 'E:\\Git\\x' },
    });
    expect(resolveWorkspace({ kind: 'location', locationId: 'git', subpath: 'moved' }, PC, paths, none)).toEqual({
      status: 'unresolved', reason: 'missing', hint: { nodeId: PC, path: 'E:\\Git\\moved' },
    });
  });
});

describe('path helpers', () => {
  it("joins with the root's own separator, and splits by whole segments", () => {
    expect(joinSubpath('E:\\Nextcloud\\', 'a/b')).toBe('E:\\Nextcloud\\a\\b');
    expect(joinSubpath('/home/adam', 'a/b')).toBe('/home/adam/a/b');
    expect(joinSubpath('/home/adam', '')).toBe('/home/adam');
    expect(relativeSegments('E:\\Git', 'E:\\Git')).toEqual([]);
    expect(relativeSegments('E:\\Git', 'E:\\Gitlab')).toBeNull();
  });
});

describe('inferLocationMapping', () => {
  it('roots the location at the first of the trailing folder names both paths share', () => {
    expect(inferLocationMapping('E:\\Nextcloud\\phd', 'C:\\Users\\Adam\\Nextcloud\\phd')).toEqual({
      fromRoot: 'E:\\Nextcloud', toRoot: 'C:\\Users\\Adam\\Nextcloud', tail: ['phd'], name: 'Nextcloud',
    });
    expect(inferLocationMapping('E:\\Nextcloud\\Work\\Notes', 'C:\\Users\\Adam\\nextcloud\\work\\notes')).toMatchObject({
      fromRoot: 'E:\\Nextcloud', toRoot: 'C:\\Users\\Adam\\nextcloud', tail: ['Work', 'Notes'],
    });
  });

  it('null with no common tail', () => {
    expect(inferLocationMapping('E:\\Git\\OtherBench', 'C:\\Projects\\Other')).toBeNull();
  });

  it('the whole path in common: the same layout on both machines, never rooted at a drive', () => {
    expect(inferLocationMapping('E:\\Git\\OtherBench', 'E:\\Git\\OtherBench')).toEqual({ fromRoot: 'E:\\Git', toRoot: 'E:\\Git', tail: ['OtherBench'], name: 'Git' });
    expect(inferLocationMapping('/notes', '/home/adam/notes')).toEqual({ fromRoot: '/notes', toRoot: '/home/adam/notes', tail: [], name: 'notes' });
  });

  it('Windows to Linux', () => {
    expect(inferLocationMapping('E:\\Nextcloud\\phd', '/home/adam/Nextcloud/phd')).toEqual({
      fromRoot: 'E:\\Nextcloud', toRoot: '/home/adam/Nextcloud', tail: ['phd'], name: 'Nextcloud',
    });
  });
});

describe('adoptIntoLocation', () => {
  it("moves a folder bound to that machine under the root into the location, and leaves everything else", () => {
    expect(adoptIntoLocation({ kind: 'machine', nodeId: PC, root: 'E:\\Git\\OtherBench\\src' }, PC, 'E:\\Git', 'git')).toEqual({ kind: 'location', locationId: 'git', subpath: 'OtherBench/src' });
    expect(adoptIntoLocation({ kind: 'machine', nodeId: PC, root: 'E:\\Git' }, PC, 'e:\\git', 'git')).toEqual({ kind: 'location', locationId: 'git', subpath: '' });
    expect(adoptIntoLocation({ kind: 'machine', nodeId: LAPTOP, root: 'E:\\Git\\x' }, PC, 'E:\\Git', 'git')).toBeNull();
    expect(adoptIntoLocation({ kind: 'machine', nodeId: PC, root: 'E:\\Gitlab' }, PC, 'E:\\Git', 'git')).toBeNull();
    expect(adoptIntoLocation({ kind: 'location', locationId: 'nc', subpath: 'x' }, PC, 'E:\\Git', 'git')).toBeNull();
    expect(adoptIntoLocation(null, PC, 'E:\\Git', 'git')).toBeNull();
  });
});

describe('extra folders', () => {
  const nc = (subpath: string): ExtraFolder['workspace'] => ({ kind: 'location', locationId: 'nc', subpath });
  const paths: LocationPath[] = [
    { locationId: 'nc', nodeId: 'pc', path: 'E:\\Nextcloud' },
    { locationId: 'nc', nodeId: 'laptop', path: 'C:\\Users\\Adam\\Nextcloud' },
  ];

  it('tells the same place by location and subfolder, or by machine and path (any case on Windows)', () => {
    expect(sameWorkspace(nc('PhD/papers'), nc('PhD/papers'))).toBe(true);
    expect(sameWorkspace(nc('PhD/papers'), nc('PhD'))).toBe(false);
    expect(sameWorkspace({ kind: 'machine', nodeId: 'pc', root: 'E:\\Git\\OtherBench' }, { kind: 'machine', nodeId: 'pc', root: 'e:\\git\\otherbench\\' })).toBe(true);
    expect(sameWorkspace({ kind: 'machine', nodeId: 'pc', root: 'E:\\Git' }, { kind: 'machine', nodeId: 'laptop', root: 'E:\\Git' })).toBe(false);
    expect(sameWorkspace(nc('Git'), { kind: 'machine', nodeId: 'pc', root: 'E:\\Nextcloud\\Git' })).toBe(false);
  });

  it("merges a project's folders and a chat's: each place once, the stricter access winning", () => {
    const project: ExtraFolder[] = [{ workspace: nc('refs'), access: 'readwrite' }, { workspace: nc('notes'), access: 'readwrite' }];
    const chat: ExtraFolder[] = [{ workspace: nc('refs'), access: 'read' }, { workspace: nc('data'), access: 'read' }];
    expect(mergeFolders(project, chat)).toEqual([
      { workspace: nc('refs'), access: 'read' },
      { workspace: nc('notes'), access: 'readwrite' },
      { workspace: nc('data'), access: 'read' },
    ]);
    expect(mergeFolders(undefined, undefined)).toEqual([]);
  });

  it('resolves the folders on this machine, leaving out any not here and the workspace itself', () => {
    const folders: ExtraFolder[] = [
      { workspace: nc('refs'), access: 'read' },
      { workspace: nc('project'), access: 'readwrite' },
      { workspace: { kind: 'machine', nodeId: 'pc', root: 'E:\\Scratch' }, access: 'readwrite' },
      { workspace: { kind: 'location', locationId: 'gone', subpath: '' }, access: 'read' },
    ];
    expect(resolveFolders(folders, 'laptop', paths, () => true, 'C:\\Users\\Adam\\Nextcloud\\project')).toEqual([{ root: 'C:\\Users\\Adam\\Nextcloud\\refs', access: 'read' }]);
    expect(resolveFolders(folders, 'pc', paths, (p) => p !== 'E:\\Nextcloud\\refs', null)).toEqual([
      { root: 'E:\\Nextcloud\\project', access: 'readwrite' },
      { root: 'E:\\Scratch', access: 'readwrite' },
    ]);
  });

  it('reads a stored list, dropping anything malformed or reaching out of its location (it arrives through sync too)', () => {
    expect(parseFolders([
      { workspace: nc('PhD'), access: 'read' },
      { workspace: nc('../../Windows'), access: 'readwrite' },
      { workspace: { kind: 'machine', nodeId: 'pc', root: 'E:\\Data' }, access: 'readwrite' },
      { workspace: { kind: 'machine', nodeId: 'pc', root: '' }, access: 'read' },
      { workspace: nc('x'), access: 'admin' },
      'nonsense',
    ])).toEqual([
      { workspace: nc('PhD'), access: 'read' },
      { workspace: { kind: 'machine', nodeId: 'pc', root: 'E:\\Data' }, access: 'readwrite' },
    ]);
    expect(parseFolders(null)).toEqual([]);
    expect(parseFolders(Array.from({ length: 15 }, (_, i) => ({ workspace: nc(`f${i}`), access: 'read' })))).toHaveLength(10);
  });
});

describe('extraFoldersPrompt and canReachFolders', () => {
  const folders = [
    { root: '/refs', access: 'read' as const },
    { root: '/out', access: 'readwrite' as const },
  ];

  it('says how to use the folders when a tool can reach them', () => {
    const text = extraFoldersPrompt(folders);
    expect(text).toContain('you can use these folders');
    expect(text).toContain('- /refs (read-only)');
    expect(text).toContain('- /out (read and write)');
  });

  it('names them for reference only, saying file access is off, when none can', () => {
    const text = extraFoldersPrompt(folders, false);
    expect(text).toContain('named for reference only');
    expect(text).toContain('file access is off');
    expect(text).toContain('- /refs');
    expect(text).not.toMatch(/read-only|read and write|you can use/);
  });

  it('counts file access, a shell on this machine or computer use as reaching them, and nothing else', () => {
    const base = { shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' as const };
    expect(canReachFolders({ ...base, fs: 'read' })).toBe(true);
    expect(canReachFolders({ ...base, fs: 'readwrite' })).toBe(true);
    expect(canReachFolders({ ...base, fs: 'off' })).toBe(false);
    expect(canReachFolders({ ...base, fs: 'off', shell: true })).toBe(true);
    expect(canReachFolders({ ...base, fs: 'off', shell: true, shellRuns: 'host' })).toBe(true);
    expect(canReachFolders({ ...base, fs: 'off', shell: true, shellRuns: 'sandbox' })).toBe(false);
    expect(canReachFolders({ ...base, fs: 'off', shell: false, shellRuns: 'sandbox', computer: true })).toBe(true);
    // A value this version doesn't know counts as off.
    expect(canReachFolders({ ...base, fs: 'everything' as never, shell: true, shellRuns: 'sandbox' })).toBe(false);
  });
});
