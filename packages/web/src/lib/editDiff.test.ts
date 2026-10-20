import { describe, expect, it } from 'vitest';
import { editDiffOf, lineDiff } from './editDiff.js';

describe('lineDiff', () => {
  it('marks a changed line as del then add, keeping context', () => {
    expect(lineDiff('x\ny', 'x\nz')).toEqual([
      { kind: 'ctx', text: 'x' },
      { kind: 'del', text: 'y' },
      { kind: 'add', text: 'z' },
    ]);
  });

  it('trims context to 3 lines around a change', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'changed');
    const lines = lineDiff(before, after);
    expect(lines.filter((l) => l.kind === 'ctx')).toHaveLength(6);
    expect(lines.map((l) => l.text)).toEqual(['l7', 'l8', 'l9', 'l10', 'changed', 'l11', 'l12', 'l13']);
  });

  it('is empty when nothing changed', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([]);
  });
});

describe('editDiffOf', () => {
  it('diffs an Edit', () => {
    const info = editDiffOf('Edit', { file_path: 'a.ts', old_string: 'x\ny', new_string: 'x\nz' });
    expect(info).toEqual({
      path: 'a.ts',
      lines: [
        { kind: 'ctx', text: 'x' },
        { kind: 'del', text: 'y' },
        { kind: 'add', text: 'z' },
      ],
      added: 1,
      removed: 1,
      isNewFile: false,
    });
  });

  it('shows a Write as all additions on a new file', () => {
    const info = editDiffOf('Write', { file_path: 'b.md', content: 'a\nb\nc' });
    expect(info?.added).toBe(3);
    expect(info?.removed).toBe(0);
    expect(info?.isNewFile).toBe(true);
    expect(info?.lines.every((l) => l.kind === 'add')).toBe(true);
  });

  it('sums a MultiEdit', () => {
    const info = editDiffOf('MultiEdit', {
      file_path: 'a.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd\ne' },
      ],
    });
    expect(info?.added).toBe(3);
    expect(info?.removed).toBe(2);
  });

  it('strips an MCP prefix', () => {
    expect(editDiffOf('mcp__x__Edit', { file_path: 'a', old_string: 'a', new_string: 'b' })).not.toBeNull();
  });

  it('covers the fs tools', () => {
    expect(editDiffOf('edit_file', { path: 'a.ts', oldString: 'a', newString: 'b' })?.path).toBe('a.ts');
    const w = editDiffOf('write_file', { path: 'a.ts', content: 'a\nb' });
    expect(w?.added).toBe(2);
    expect(w?.isNewFile).toBe(true);
  });

  it('is null for other tools and malformed args', () => {
    expect(editDiffOf('Read', { file_path: 'a' })).toBeNull();
    expect(editDiffOf('Edit', { file_path: 'a', old_string: 1, new_string: 'b' })).toBeNull();
    expect(editDiffOf('Edit', null)).toBeNull();
    expect(editDiffOf('MultiEdit', { file_path: 'a', edits: [{ old_string: 'a' }] })).toBeNull();
  });

  it('cuts a diff over 400 lines with a count', () => {
    const content = Array.from({ length: 450 }, (_, i) => `l${i}`).join('\n');
    const info = editDiffOf('Write', { file_path: 'big', content });
    expect(info?.added).toBe(450);
    expect(info?.lines).toHaveLength(400);
    expect(info?.truncated).toBe(50);
  });
});
