import { describe, expect, it } from 'vitest';
import { looksLikePath, toolPath } from './paths.js';

describe('looksLikePath', () => {
  it('takes absolute, explicitly relative and folder/file paths, and bare file names it knows', () => {
    for (const yes of ['C:\\Users\\Adam\\My Files\\a.md', '/home/a/b.txt', './x/y', '../up.md', 'src/main.ts', 'packages\\web\\App.tsx', 'README.md', 'pic.png']) {
      expect(looksLikePath(yes), yes).toBe(true);
    }
  });
  it('leaves code, URLs and prose alone', () => {
    for (const no of ['', 'foo()', 'a.b.c', 'npm run build', 'https://example.com/a.md', 'x?.y', 'line\nbreak', 'src/ main.ts']) {
      expect(looksLikePath(no), no).toBe(false);
    }
  });
});

describe('toolPath', () => {
  it("finds a file tool call's path, but not a folder tool's", () => {
    expect(toolPath('read_file', { path: 'notes.md' })).toBe('notes.md');
    expect(toolPath('Read', { file_path: 'C:\\a.md' })).toBe('C:\\a.md');
    expect(toolPath('NotebookEdit', { notebook_path: '/n.ipynb' })).toBe('/n.ipynb');
    for (const [name, args] of [['list_dir', { path: '.' }], ['LS', { path: '/x' }], ['Glob', { path: 'src' }], ['Grep', { path: 'src' }], ['search_files', { path: 'src' }], ['read_file', {}], ['read_file', null], ['read_file', { path: '  ' }]] as const) {
      expect(toolPath(name, args)).toBeNull();
    }
  });
});
