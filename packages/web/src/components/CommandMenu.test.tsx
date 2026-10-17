import { describe, expect, it } from 'vitest';
import type { CommandRow } from '@otherbench/core/domain/context-lines.js';
import { filterCommands } from './CommandMenu.js';

const row = (name: string, aliases: string[] = []): CommandRow => ({ name, description: '', argumentHint: '', aliases });

describe('filterCommands', () => {
  it('matches prefixes, in input order', () => {
    const all = [row('clear'), row('compact'), row('context'), row('deploy')];
    expect(filterCommands(all, 'c').map((c) => c.name)).toEqual(['clear', 'compact', 'context']);
  });
  it('puts alias and prefix matches before substring matches', () => {
    const all = [row('security-review'), row('code-review'), row('clear', ['reset', 'new']), row('deploy')];
    expect(filterCommands(all, 're').map((c) => c.name)).toEqual(['clear', 'security-review', 'code-review']);
  });
  it('is case-insensitive and returns everything for an empty query', () => {
    const all = [row('clear'), row('compact')];
    expect(filterCommands(all, 'CL').map((c) => c.name)).toEqual(['clear']);
    expect(filterCommands(all, '')).toHaveLength(2);
  });
});
