import { describe, it, expect } from 'vitest';
import { compareProjects, PROJECT_NAME_MAX, projectDisplayName, projectInstructionsPrompt, projectLookup, projectParentOf } from '../src/domain/projects.js';
import type { Project } from '../src/ports/store.js';

function project(id: string, name: string, sortOrder: number): Project {
  return { id, name, workspaceRoot: null, defaultProfileId: null, sortOrder, createdAt: 1, updatedAt: 1 };
}

describe('compareProjects', () => {
  it('orders by sortOrder, then name ignoring ASCII case, then id', () => {
    const sorted = [
      project('p3', 'beta', 1),
      project('p5', 'Same', 1),
      project('p2', 'Alpha', 1),
      project('p4', 'same', 1),
      project('p1', 'Zed', 0),
    ].sort(compareProjects);
    expect(sorted.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('caps names at 80 characters', () => {
    expect(PROJECT_NAME_MAX).toBe(80);
  });
});

describe('projectInstructionsPrompt', () => {
  it('heads the instructions with the project name and tells the model to follow them', () => {
    expect(projectInstructionsPrompt('Alpha', 'Be brief.')).toBe(
      '# Project instructions: Alpha\nInstructions from the user for every chat in this project. Follow them unless the user says otherwise in this chat.\n\nBe brief.'
    );
  });

  it('turns CRLF into LF and trims, and is null when nothing is left', () => {
    expect(projectInstructionsPrompt('A', '\r\n  One.\r\nTwo.  \r\n')).toMatch(/\n\nOne\.\nTwo\.$/);
    expect(projectInstructionsPrompt('A', '')).toBeNull();
    expect(projectInstructionsPrompt('A', ' \r\n\t ')).toBeNull();
  });
});

describe('projectParentOf and projectDisplayName', () => {
  const nested = (id: string, name: string, parentId: string | null): Project => ({ ...project(id, name, 0), parentId });

  it('finds a top-level parent and names the child after it', () => {
    const grunt = nested('g', 'Grunt', null);
    const desktop = nested('d', 'Desktop', 'g');
    const lookup = projectLookup([grunt, desktop]);
    expect(projectParentOf(desktop, lookup)).toBe(grunt);
    expect(projectDisplayName(desktop, lookup)).toBe('Grunt / Desktop');
    expect(projectParentOf(grunt, lookup)).toBeNull();
    expect(projectDisplayName(grunt, lookup)).toBe('Grunt');
  });

  it('treats a project as top level when its parent is missing, itself, or nested', () => {
    const orphan = nested('o', 'Orphan', 'gone');
    const self = nested('s', 'Self', 's');
    const top = nested('t', 'Top', null);
    const mid = nested('m', 'Mid', 't');
    const deep = nested('x', 'Deep', 'm');
    const lookup = projectLookup([orphan, self, top, mid, deep]);
    expect(projectParentOf(orphan, lookup)).toBeNull();
    expect(projectParentOf(self, lookup)).toBeNull();
    expect(projectParentOf(deep, lookup)).toBeNull();
    expect(projectDisplayName(deep, lookup)).toBe('Deep');
    expect(projectParentOf(mid, lookup)).toBe(top);
  });

  it('shows both of a two-project cycle at the top level', () => {
    const a = nested('a', 'A', 'b');
    const b = nested('b', 'B', 'a');
    const lookup = projectLookup([a, b]);
    expect(projectParentOf(a, lookup)).toBeNull();
    expect(projectParentOf(b, lookup)).toBeNull();
  });

  it('reads an absent parentId as top level', () => {
    expect(projectParentOf(project('p', 'P', 0), projectLookup([]))).toBeNull();
  });
});
