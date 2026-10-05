import { describe, expect, it } from 'vitest';
import { adoptIntoLocation, classifyPath, inferLocationMapping, joinSubpath, relativeSegments, resolveWorkspace } from '../src/domain/workspace.js';
import type { LocationPath } from '../src/types/workspace.js';

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
    expect(resolveWorkspace({ kind: 'location', locationId: 'git', subpath: 'Grunt' }, LAPTOP, paths, all)).toEqual({
      status: 'unresolved', reason: 'no-location-path', hint: { nodeId: PC, path: 'E:\\Git\\Grunt' },
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
    expect(inferLocationMapping('E:\\Git\\Grunt', 'C:\\Projects\\Other')).toBeNull();
  });

  it('the whole path in common: the same layout on both machines, never rooted at a drive', () => {
    expect(inferLocationMapping('E:\\Git\\Grunt', 'E:\\Git\\Grunt')).toEqual({ fromRoot: 'E:\\Git', toRoot: 'E:\\Git', tail: ['Grunt'], name: 'Git' });
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
    expect(adoptIntoLocation({ kind: 'machine', nodeId: PC, root: 'E:\\Git\\Grunt\\src' }, PC, 'E:\\Git', 'git')).toEqual({ kind: 'location', locationId: 'git', subpath: 'Grunt/src' });
    expect(adoptIntoLocation({ kind: 'machine', nodeId: PC, root: 'E:\\Git' }, PC, 'e:\\git', 'git')).toEqual({ kind: 'location', locationId: 'git', subpath: '' });
    expect(adoptIntoLocation({ kind: 'machine', nodeId: LAPTOP, root: 'E:\\Git\\x' }, PC, 'E:\\Git', 'git')).toBeNull();
    expect(adoptIntoLocation({ kind: 'machine', nodeId: PC, root: 'E:\\Gitlab' }, PC, 'E:\\Git', 'git')).toBeNull();
    expect(adoptIntoLocation({ kind: 'location', locationId: 'nc', subpath: 'x' }, PC, 'E:\\Git', 'git')).toBeNull();
    expect(adoptIntoLocation(null, PC, 'E:\\Git', 'git')).toBeNull();
  });
});
