import { describe, expect, it } from 'vitest';
import { DIFF_TRUNCATED_MARKER, diffTruncated, editDiffOf, lineDiff, parseUnifiedDiff } from './editDiff.js';

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

  it('marks the skipped lines between two far-apart changes with a gap row', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l2', 'A').replace('l15', 'B');
    const kinds = lineDiff(before, after).map((l) => l.kind);
    expect(kinds.filter((k) => k === 'gap')).toHaveLength(1);
    expect(kinds[0]).not.toBe('gap');
    expect(kinds[kinds.length - 1]).not.toBe('gap');
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

  it('separates the edits of a MultiEdit with a gap row', () => {
    const info = editDiffOf('MultiEdit', {
      file_path: 'a.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    });
    expect(info?.lines.map((l) => l.kind)).toEqual(['del', 'add', 'gap', 'del', 'add']);
    expect(info?.added).toBe(2);
  });

  it('falls back to a plain delete-then-add for a pair too big to diff', () => {
    const before = ['first', ...Array.from({ length: 998 }, (_, i) => `m${i}`), 'last'].join('\n');
    const after = ['FIRST', ...Array.from({ length: 998 }, (_, i) => `m${i}`), 'LAST'].join('\n');
    const info = editDiffOf('Edit', { file_path: 'big', old_string: before, new_string: after });
    expect(info?.removed).toBe(1000);
    expect(info?.added).toBe(1000);
    expect(info?.lines.some((l) => l.kind === 'ctx')).toBe(false);
  });

  it('computes once per args object', () => {
    const args = { file_path: 'a.ts', old_string: 'x', new_string: 'y' };
    expect(editDiffOf('Edit', args)).toBe(editDiffOf('Edit', args));
  });
});

describe('parseUnifiedDiff', () => {
  const twoFiles = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-old',
    '+new',
    '@@ -10,2 +10,3 @@ function f() {',
    ' tail',
    '+more',
    '\\ No newline at end of file',
    'diff --git a/b.txt b/b.txt',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/b.txt',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    '',
  ].join('\n');

  it('returns one entry per file with its add, del and context lines', () => {
    const files = parseUnifiedDiff(twoFiles);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'b.txt']);
    expect(files[0]!.lines).toEqual([
      { kind: 'ctx', text: 'keep' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'gap', text: '' },
      { kind: 'ctx', text: 'tail' },
      { kind: 'add', text: 'more' },
    ]);
    expect(files[1]!.lines).toEqual([
      { kind: 'add', text: 'one' },
      { kind: 'add', text: 'two' },
    ]);
  });

  it('names a deleted file by its old path', () => {
    const text = 'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n';
    expect(parseUnifiedDiff(text)).toEqual([{ path: 'gone.ts', lines: [{ kind: 'del', text: 'bye' }] }]);
  });

  it("drops the server's truncation marker, which diffTruncated reports", () => {
    const text = `${twoFiles}${DIFF_TRUNCATED_MARKER}\n`;
    expect(parseUnifiedDiff(text).at(-1)!.lines.at(-1)).toEqual({ kind: 'add', text: 'two' });
    expect(diffTruncated(text)).toBe(true);
    expect(diffTruncated(twoFiles)).toBe(false);
  });

  it('is empty for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});
