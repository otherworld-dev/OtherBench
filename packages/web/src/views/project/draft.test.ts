import { describe, expect, it } from 'vitest';
import type { Project } from '@grunt/core/ports/store.js';
import { createBody, draftFromProject, draftProblem, emptyDraft, isDirty, patchBody, type ProjectDraft } from './draft.js';

const machine = (root: string) => ({ kind: 'machine' as const, nodeId: 'n1', root });

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Alpha',
    description: 'A workbench',
    instructions: 'Be brief.',
    workspace: machine('/srv/alpha'),
    workspaceRoot: '/srv/alpha',
    folders: [{ workspace: machine('/srv/notes'), access: 'readwrite' }],
    folderViews: [{ workspace: machine('/srv/notes'), access: 'readwrite', root: '/srv/notes', status: { status: 'ok', root: '/srv/notes' } }],
    defaultProfileId: 'profile-1',
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('draftFromProject', () => {
  it('fills every field, keeping each other folder in its stored form with its path to show', () => {
    expect(draftFromProject(project())).toEqual({
      name: 'Alpha',
      description: 'A workbench',
      instructions: 'Be brief.',
      folder: '/srv/alpha',
      folders: [{ entry: { workspace: machine('/srv/notes'), access: 'readwrite' }, display: '/srv/notes', away: false }],
      defaultProfileId: 'profile-1',
      parentId: '',
    });
  });

  it('marks an other folder that is not on this machine as away', () => {
    const elsewhere = { ...machine('D:/notes'), nodeId: 'other' };
    const d = draftFromProject(
      project({
        folders: [{ workspace: elsewhere, access: 'read' }],
        folderViews: [{ workspace: elsewhere, access: 'read', root: null, status: { status: 'unresolved', reason: 'other-machine', hint: { nodeId: 'other', path: 'D:/notes' } } }],
      })
    );
    expect(d.folders).toEqual([{ entry: { workspace: elsewhere, access: 'read' }, display: 'D:/notes', away: true }]);
  });

  it('reads no folder, no other folders and App default as empty', () => {
    const d = draftFromProject(project({ workspace: null, workspaceRoot: null, folders: [], folderViews: [], defaultProfileId: null }));
    expect(d).toMatchObject({ folder: '', folders: [], defaultProfileId: '' });
  });
});

describe('createBody', () => {
  it('trims the name, description and folder, maps empties to null, and sends every other folder', () => {
    const draft: ProjectDraft = {
      name: '  Grunt ',
      description: ' Local ',
      instructions: '  keep as typed  ',
      folder: ' /home/me/grunt ',
      folders: [{ entry: { path: '/home/me/notes', access: 'read' }, display: '/home/me/notes' }],
      defaultProfileId: '',
      parentId: '',
    };
    expect(createBody(draft)).toEqual({
      name: 'Grunt',
      description: 'Local',
      instructions: '  keep as typed  ',
      workspaceRoot: '/home/me/grunt',
      defaultProfileId: null,
      folders: [{ path: '/home/me/notes', access: 'read' }],
    });
    expect(createBody({ ...draft, folder: '  ' }).workspaceRoot).toBeNull();
  });

  it('sends the parent only for a sub-project', () => {
    expect(createBody({ ...emptyDraft('p-top'), name: 'Desktop' }).parentId).toBe('p-top');
    expect(createBody({ ...emptyDraft(), name: 'Top' })).not.toHaveProperty('parentId');
  });
});

describe('the parent in a patch (spec 2026-10-15-sub-projects-design §5)', () => {
  it('reads the parent, and sends a change of it, null for top level', () => {
    const initial = draftFromProject(project({ parentId: 'p-top' }));
    expect(initial.parentId).toBe('p-top');
    expect(patchBody(initial, { ...initial, parentId: '' })).toEqual({ parentId: null });
    expect(patchBody(initial, { ...initial, parentId: 'p-other' })).toEqual({ parentId: 'p-other' });
    expect(patchBody(initial, { ...initial })).toEqual({});
  });
});

describe('patchBody and isDirty', () => {
  it('sends nothing, and is clean, when nothing changed', () => {
    const initial = draftFromProject(project());
    expect(patchBody(initial, { ...initial })).toEqual({});
    expect(isDirty(initial, { ...initial })).toBe(false);
  });

  it('sends only the fields that changed', () => {
    const initial = draftFromProject(project());
    const draft = { ...initial, instructions: 'Be thorough.', folder: '', defaultProfileId: '' };
    expect(isDirty(initial, draft)).toBe(true);
    expect(patchBody(initial, draft)).toEqual({ instructions: 'Be thorough.', workspaceRoot: null, defaultProfileId: null });
  });

  it('sends the whole folder list when any folder changed', () => {
    const initial = draftFromProject(project());
    const folders = [...initial.folders, { entry: { path: '/srv/more', access: 'read' as const }, display: '/srv/more' }];
    expect(patchBody(initial, { ...initial, folders })).toEqual({
      folders: [{ workspace: machine('/srv/notes'), access: 'readwrite' }, { path: '/srv/more', access: 'read' }],
    });
  });
});

describe('draftProblem', () => {
  it('needs a name, and checks the limits and the folder', () => {
    const ok = { ...emptyDraft(), name: 'Grunt' };
    expect(draftProblem(ok, 'linux')).toBeNull();
    expect(draftProblem({ ...ok, name: '   ' }, 'linux')).toBe('Give the project a name.');
    expect(draftProblem({ ...ok, name: 'x'.repeat(81) }, 'linux')).toBe('The name can be at most 80 characters.');
    expect(draftProblem({ ...ok, description: 'x'.repeat(501) }, 'linux')).toBe('The description can be at most 500 characters.');
    expect(draftProblem({ ...ok, instructions: 'x'.repeat(8_000) }, 'linux')).toBeNull();
    expect(draftProblem({ ...ok, instructions: 'x'.repeat(8_001) }, 'linux')).toBe('The instructions can be at most 8,000 characters.');
    expect(draftProblem({ ...ok, folder: 'relative' }, 'linux')).not.toBeNull();
  });
});
