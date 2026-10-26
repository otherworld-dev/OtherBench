import { describe, expect, it } from 'vitest';
import { columnKind } from '../src/domain/deck-columns.js';

describe('columnKind', () => {
  it.each([
    ['Doing', 'doing'], [' WIP ', 'doing'], ['In Progress', 'doing'], ['in-progress', 'doing'],
    ['To Do', 'todo'], ['todo', 'todo'], ['To-Do', 'todo'],
    ['Backlog', 'backlog'], ['Done', 'done'], ['Ideas', 'other'], ['', 'other'],
  ])('%j is %s', (title, kind) => {
    expect(columnKind(title)).toBe(kind);
  });
});
