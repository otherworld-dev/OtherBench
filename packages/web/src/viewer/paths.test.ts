import { describe, expect, it } from 'vitest';
import { artifactOutcomeOf, isArtifactTool, looksLikePath, toolPath } from './paths.js';

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

describe('artifactOutcomeOf', () => {
  it("reads an artifact call's outcome from a result string, an MCP content list or an object", () => {
    const outcome = { ok: true, command: 'create', artifactId: 'art', slug: 'calc', title: 'Calc', kind: 'html', number: 1, versionId: 'v1' };
    expect(artifactOutcomeOf(JSON.stringify(outcome))).toMatchObject({ artifactId: 'art', number: 1 });
    expect(artifactOutcomeOf([{ type: 'text', text: JSON.stringify(outcome) }])).toMatchObject({ title: 'Calc' });
    expect(artifactOutcomeOf(outcome)).toMatchObject({ command: 'create' });
    for (const no of [null, 'oops', { error: true }, { ...outcome, command: 'view' }, [{ type: 'image' }]]) expect(artifactOutcomeOf(no)).toBeNull();
    expect(isArtifactTool('artifact')).toBe(true);
    // Both engines report OtherBench's tool as `artifact`; a server named otherbench is just an MCP server.
    expect(isArtifactTool('mcp__otherbench__artifact')).toBe(false);
    expect(isArtifactTool('read_file')).toBe(false);
  });
});
