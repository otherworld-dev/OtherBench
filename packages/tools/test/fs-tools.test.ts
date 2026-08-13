import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { constants as fsConstants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@grunt/core/ports/tool-provider.js';
import {
  readFileTool,
  listDirTool,
  searchFilesTool,
  writeFileTool,
  editFileTool,
  fsTools,
  ToctouGuardError,
  __testing,
} from '../src/fs-tools.js';

let base: string;
let ws: string;
let outside: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    chatId: 'chat-1',
    messageId: 'msg-1',
    profileId: 'profile-1',
    workspaceRoot: ws,
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'grunt-fs-tools-'));
  ws = join(base, 'ws');
  outside = join(base, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
});

afterEach(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe('fsTools export', () => {
  it('lists all five tools with source fs', () => {
    expect(fsTools.map((t) => t.name).sort()).toEqual(
      ['edit_file', 'list_dir', 'read_file', 'search_files', 'write_file'].sort()
    );
    for (const tool of fsTools) expect(tool.source).toBe('fs');
  });
});

describe('read_file', () => {
  it('reads the full content of a small file', async () => {
    writeFileSync(join(ws, 'a.txt'), 'line1\nline2\nline3');
    const result = (await readFileTool.execute({ path: 'a.txt' }, ctx())) as Record<string, unknown>;
    expect(result.content).toBe('line1\nline2\nline3');
    expect(result.truncated).toBe(false);
  });

  it('restricts output to a 1-indexed inclusive line range', async () => {
    writeFileSync(join(ws, 'a.txt'), 'line1\nline2\nline3\nline4');
    const result = (await readFileTool.execute({ path: 'a.txt', startLine: 2, endLine: 3 }, ctx())) as Record<string, unknown>;
    expect(result.content).toBe('line2\nline3');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
  });

  it('clamps an out-of-range line request instead of erroring', async () => {
    writeFileSync(join(ws, 'a.txt'), 'line1\nline2');
    const result = (await readFileTool.execute({ path: 'a.txt', startLine: 1, endLine: 999 }, ctx())) as Record<string, unknown>;
    expect(result.content).toBe('line1\nline2');
    expect(result.endLine).toBe(2);
  });

  it('refuses a binary file with a structured error instead of decoding it to mojibake', async () => {
    writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f, 0xff, 0xfe]));
    const result = (await readFileTool.execute({ path: 'bin.dat' }, ctx())) as Record<string, unknown>;
    expect(result.error).toBe(true);
    expect(result.code).toBe('binary_file');
  });

  it('truncates a file over the 1MB cap and reports it, without throwing', async () => {
    writeFileSync(join(ws, 'big.txt'), 'a'.repeat(1024 * 1024 + 500));
    const result = (await readFileTool.execute({ path: 'big.txt' }, ctx())) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.truncated).toBe(true);
    expect((result.content as string).length).toBeLessThanOrEqual(1024 * 1024);
    expect(typeof result.note).toBe('string');
  });

  it('returns a not_found tool error for a missing file rather than throwing', async () => {
    const result = (await readFileTool.execute({ path: 'nope.txt' }, ctx())) as Record<string, unknown>;
    expect(result.error).toBe(true);
    expect(result.code).toBe('not_found');
  });

  it('returns is_a_directory rather than throwing when given a directory', async () => {
    mkdirSync(join(ws, 'adir'));
    const result = (await readFileTool.execute({ path: 'adir' }, ctx())) as Record<string, unknown>;
    expect(result.error).toBe(true);
    expect(result.code).toBe('is_a_directory');
  });

  it('surfaces a path-escape attempt as a structured tool error, not an exception', async () => {
    const promise = readFileTool.execute({ path: '../outside/secret.txt' }, ctx());
    await expect(promise).resolves.toMatchObject({ error: true, code: 'path_escape' });
  });
});

describe('list_dir', () => {
  it('lists immediate entries sorted by name, with type', async () => {
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'b.txt'), 'x');
    writeFileSync(join(ws, 'a.txt'), 'x');
    const result = (await listDirTool.execute({}, ctx())) as Record<string, unknown>;
    expect(result.entries).toEqual([
      { name: 'a.txt', type: 'file' },
      { name: 'b.txt', type: 'file' },
      { name: 'sub', type: 'dir' },
    ]);
  });

  it('surfaces a path-escape attempt as a structured tool error, not an exception', async () => {
    const promise = listDirTool.execute({ path: '../outside' }, ctx());
    await expect(promise).resolves.toMatchObject({ error: true, code: 'path_escape' });
  });
});

describe('search_files', () => {
  it('matches filenames by glob', async () => {
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(ws, 'src', 'b.md'), '# not typescript');
    const result = (await searchFilesTool.execute({ glob: 'src/**/*.ts' }, ctx())) as Record<string, unknown>;
    const matches = result.matches as { path: string }[];
    expect(matches.map((m) => m.path)).toEqual(['src/a.ts']);
  });

  it('greps file content by plain substring, reporting line numbers', async () => {
    writeFileSync(join(ws, 'a.txt'), 'first\nfindme here\nlast');
    const result = (await searchFilesTool.execute({ query: 'findme' }, ctx())) as Record<string, unknown>;
    const matches = result.matches as { path: string; line?: number }[];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: 'a.txt', line: 2 });
  });

  it('combines glob and query', async () => {
    writeFileSync(join(ws, 'a.ts'), 'findme');
    writeFileSync(join(ws, 'a.md'), 'findme');
    const result = (await searchFilesTool.execute({ glob: '*.ts', query: 'findme' }, ctx())) as Record<string, unknown>;
    const matches = result.matches as { path: string }[];
    expect(matches.map((m) => m.path)).toEqual(['a.ts']);
  });

  it('silently skips binary files during a content search instead of erroring', async () => {
    writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x66, 0x69, 0x6e, 0x64, 0x6d, 0x65]));
    writeFileSync(join(ws, 'text.txt'), 'findme');
    const result = (await searchFilesTool.execute({ query: 'findme' }, ctx())) as Record<string, unknown>;
    const matches = result.matches as { path: string }[];
    expect(matches.map((m) => m.path)).toEqual(['text.txt']);
  });

  it('excludes node_modules from the walk', async () => {
    mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(ws, 'node_modules', 'pkg', 'index.js'), 'findme');
    writeFileSync(join(ws, 'app.js'), 'findme');
    const result = (await searchFilesTool.execute({ query: 'findme' }, ctx())) as Record<string, unknown>;
    const matches = result.matches as { path: string }[];
    expect(matches.map((m) => m.path)).toEqual(['app.js']);
  });

  it('requires at least one of glob or query', async () => {
    const result = (await searchFilesTool.execute({}, ctx())) as Record<string, unknown>;
    expect(result.error).toBe(true);
    expect(result.code).toBe('bad_args');
  });

  it('surfaces a path-escape attempt as a structured tool error, not an exception', async () => {
    const promise = searchFilesTool.execute({ path: '../outside', glob: '*' }, ctx());
    await expect(promise).resolves.toMatchObject({ error: true, code: 'path_escape' });
  });
});

describe('write_file', () => {
  it('creates a new file, including new nested parent directories', async () => {
    const result = (await writeFileTool.execute({ path: 'a/b/c/new.txt', content: 'hello' }, ctx())) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.bytesWritten).toBe(5);
  });

  it('overwrites an existing file', async () => {
    writeFileSync(join(ws, 'a.txt'), 'old content');
    await writeFileTool.execute({ path: 'a.txt', content: 'new' }, ctx());
    const after = (await readFileTool.execute({ path: 'a.txt' }, ctx())) as Record<string, unknown>;
    expect(after.content).toBe('new');
  });

  it('surfaces a path-escape attempt as a structured tool error, not an exception, and writes nothing outside', async () => {
    const promise = writeFileTool.execute({ path: '../outside/pwned.txt', content: 'evil' }, ctx());
    await expect(promise).resolves.toMatchObject({ error: true, code: 'path_escape' });
    const outsideListing = (await listDirTool.execute({}, ctx({ workspaceRoot: outside }))) as Record<string, unknown>;
    const names = (outsideListing.entries as { name: string }[]).map((e) => e.name);
    expect(names).not.toContain('pwned.txt');
  });
});

describe('edit_file', () => {
  it('replaces a unique match', async () => {
    writeFileSync(join(ws, 'a.txt'), 'hello world');
    const result = (await editFileTool.execute({ path: 'a.txt', oldString: 'world', newString: 'there' }, ctx())) as Record<
      string,
      unknown
    >;
    expect(result.replaced).toBe(true);
    const after = (await readFileTool.execute({ path: 'a.txt' }, ctx())) as Record<string, unknown>;
    expect(after.content).toBe('hello there');
  });

  it('fails on zero occurrences and leaves the file unchanged', async () => {
    writeFileSync(join(ws, 'a.txt'), 'hello world');
    const result = (await editFileTool.execute({ path: 'a.txt', oldString: 'nope', newString: 'x' }, ctx())) as Record<
      string,
      unknown
    >;
    expect(result.error).toBe(true);
    const after = (await readFileTool.execute({ path: 'a.txt' }, ctx())) as Record<string, unknown>;
    expect(after.content).toBe('hello world');
  });

  it('fails on a non-unique match and leaves the file unchanged', async () => {
    writeFileSync(join(ws, 'a.txt'), 'foo bar foo');
    const result = (await editFileTool.execute({ path: 'a.txt', oldString: 'foo', newString: 'baz' }, ctx())) as Record<
      string,
      unknown
    >;
    expect(result.error).toBe(true);
    expect(result.code).toBe('not_unique');
    const after = (await readFileTool.execute({ path: 'a.txt' }, ctx())) as Record<string, unknown>;
    expect(after.content).toBe('foo bar foo');
  });

  it('refuses to edit a binary file', async () => {
    writeFileSync(join(ws, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
    const result = (await editFileTool.execute({ path: 'bin.dat', oldString: 'a', newString: 'b' }, ctx())) as Record<
      string,
      unknown
    >;
    expect(result.error).toBe(true);
    expect(result.code).toBe('binary_file');
  });

  it('surfaces a path-escape attempt as a structured tool error, not an exception', async () => {
    const promise = editFileTool.execute({ path: '../outside/secret.txt', oldString: 'a', newString: 'b' }, ctx());
    await expect(promise).resolves.toMatchObject({ error: true, code: 'path_escape' });
  });
});

describe('TOCTOU guard (openVerified)', () => {
  it('does not false-positive on an ordinary, unraced open', async () => {
    writeFileSync(join(ws, 'a.txt'), 'hello');
    const { handle } = await __testing.openVerified(ws, 'a.txt', fsConstants.O_RDONLY);
    await handle.close();
  });

  it('detects an ancestor directory swapped for a junction between the containment check and the open, and refuses', async () => {
    // Reproduces the exact scenario the TOCTOU ruling described: a checked
    // directory replaced by a junction between check and use, redirecting a
    // literal in-workspace path string to a target outside the workspace.
    const sub = join(ws, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'file.txt'), 'original-inside-content');
    const resolvedPath = join(sub, 'file.txt');

    let swapped = false;
    const raceHook = () => {
      rmSync(sub, { recursive: true, force: true });
      try {
        symlinkSync(outside, sub, 'junction');
      } catch {
        return; // needs privilege on some platforms/configs -- test below no-ops if so
      }
      writeFileSync(join(outside, 'file.txt'), 'ATTACKER-CONTROLLED-OUTSIDE-CONTENT');
      swapped = true;
    };

    const promise = __testing.openVerified(ws, 'sub/file.txt', fsConstants.O_RDONLY, {
      __raceHookForTests: raceHook,
    });

    if (!swapped) {
      // Could not create the junction unprivileged in this environment; the
      // swap never happened, so the open must succeed normally instead.
      const { handle } = await promise;
      await handle.close();
      return;
    }

    await expect(promise).rejects.toBeInstanceOf(ToctouGuardError);
    // The attacker's content must never have been readable through the
    // resolved path: openVerified must have refused before returning a
    // usable handle, not merely logged a warning.
    void resolvedPath;
  });
});
