import { describe, it, expect } from 'vitest';
import { compareProjects, PROJECT_NAME_MAX, projectInstructionsPrompt } from '../src/domain/projects.js';
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
