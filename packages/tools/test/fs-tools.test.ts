import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  constants as fsConstants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ToolContext } from '@grunt/core/ports/tool-provider.js';
import {
  readFileTool,
  listDirTool,
  searchFilesTool,
  writeFileTool,
  editFileTool,
  fsTools,
  HardLinkError,
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

// ---------------------------------------------------------------------------
// Attack reproductions
//
// Every test below performs the real attack -- a real hard link, a real
// directory-for-junction swap, a real concurrent racer -- rather than
// asserting on the guard logic in isolation. Where a hook is used it is only
// to CHOOSE WHICH WINDOW the real swap lands in; the swap itself is a genuine
// filesystem operation. A hooked approximation is precisely what let the
// TOCTOU defect through last time: the old test hooked the one sub-window the
// old guard happened to cover.
// ---------------------------------------------------------------------------

const ATTACKER_MARKER = 'ATTACKER-CONTROLLED-OUTSIDE-CONTENT';
const SECRET_MARKER = 'TOP-SECRET-OUTSIDE-DATA';

/**
 * Creates a directory junction (Windows) / symlink (POSIX) and FAILS LOUDLY
 * if it cannot, instead of letting the caller quietly turn into a no-op test.
 * Directory junctions need no elevation on Windows and symlinks need none on
 * POSIX, so an inability to create one is a broken environment, not an
 * expected condition -- and a test that silently passes when the attack it
 * exists to reproduce could not even be set up is worse than no test.
 */
function makeJunctionOrThrow(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch (err) {
    throw new Error(
      `Could not create a directory junction at "${linkPath}" -> "${target}". This test reproduces a real ` +
        'containment bypass and cannot be allowed to pass vacuously; fix the environment rather than skipping it. ' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

describe('hard links defeat path containment unless refused outright', () => {
  // No race, no privilege, 100% reliable. `mklink /H` (Windows) and link(2)
  // (POSIX) create a second directory entry -- inside the workspace -- for a
  // file that lives outside it. realpath() on that entry returns the entry's
  // own in-workspace path, because the entry IS the file, so containPath sees
  // nothing wrong; an identity check sees a perfectly stable identity for the
  // same reason. The model creates the link with run_command (one approval)
  // and can then read or clobber any same-volume file the user can.

  function hardLinkOutsideFileIntoWorkspace(name: string, content: string): string {
    const target = join(outside, `${name}.txt`);
    writeFileSync(target, content);
    const link = join(ws, `${name}-link.txt`);
    try {
      linkSync(target, link);
    } catch (err) {
      throw new Error(
        `Could not create a hard link at "${link}" -> "${target}". This test reproduces a real containment ` +
          `bypass and must not pass vacuously. Underlying error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return target;
  }

  it('read_file refuses a hard link to an outside file instead of leaking its content', async () => {
    hardLinkOutsideFileIntoWorkspace('secret', SECRET_MARKER);
    const result = (await readFileTool.execute({ path: 'secret-link.txt' }, ctx())) as Record<string, unknown>;

    expect(result.error).toBe(true);
    expect(result.code).toBe('hard_link');
    expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);

    // containPath is happy with it -- that is the whole point. The refusal
    // has to come from the link count on the opened handle, nothing else.
    await expect(__testing.openVerified(ws, 'secret-link.txt', fsConstants.O_RDONLY)).rejects.toBeInstanceOf(
      HardLinkError
    );
  });

  it('edit_file refuses a hard link to an outside file, leaving it untouched', async () => {
    const target = hardLinkOutsideFileIntoWorkspace('editable', SECRET_MARKER);
    const result = (await editFileTool.execute(
      { path: 'editable-link.txt', oldString: SECRET_MARKER, newString: 'PWNED' },
      ctx()
    )) as Record<string, unknown>;

    expect(result.error).toBe(true);
    expect(result.code).toBe('hard_link');
    expect(readFileSync(target, 'utf8')).toBe(SECRET_MARKER);
  });

  it('search_files does not grep content out of a hard-linked outside file', async () => {
    hardLinkOutsideFileIntoWorkspace('grepped', SECRET_MARKER);
    const result = (await searchFilesTool.execute({ query: SECRET_MARKER }, ctx())) as Record<string, unknown>;
    expect(result.matches).toEqual([]);
  });

  it('a genuinely in-workspace file with a single link is unaffected', async () => {
    writeFileSync(join(ws, 'ordinary.txt'), 'ordinary content');
    const result = (await readFileTool.execute({ path: 'ordinary.txt' }, ctx())) as Record<string, unknown>;
    expect(result.content).toBe('ordinary content');
  });

  it('the refusal is symmetric: two links INSIDE the workspace are refused too, and that is accepted', async () => {
    // Documenting the false-positive cost honestly rather than pretending it
    // away: the link count cannot distinguish "second name inside" from
    // "second name outside", so legitimately hard-linked trees are refused.
    writeFileSync(join(ws, 'orig.txt'), 'inside content');
    linkSync(join(ws, 'orig.txt'), join(ws, 'alias.txt'));
    const result = (await readFileTool.execute({ path: 'orig.txt' }, ctx())) as Record<string, unknown>;
    expect(result.code).toBe('hard_link');
  });
});

describe('write_file must not destroy the target before the guard refuses', () => {
  it('leaves a hard-linked outside file byte-for-byte intact when it refuses', async () => {
    // O_TRUNC truncates at open() -- before any identity comparison, before
    // the hard-link check, before the second containment verdict. The file
    // was therefore already zeroed by the time the guard said no. This is a
    // deterministic reproduction: no race, the refusal is guaranteed, so the
    // only question is whether the file survived it.
    const target = join(outside, 'victim.txt');
    writeFileSync(target, SECRET_MARKER);
    linkSync(target, join(ws, 'victim-link.txt'));

    const result = (await writeFileTool.execute({ path: 'victim-link.txt', content: 'PWNED' }, ctx())) as Record<
      string,
      unknown
    >;

    expect(result.error).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(SECRET_MARKER);
  });

  it('leaves the target intact when the TOCTOU guard refuses a swapped path', async () => {
    // The same property on the racy path: the refusal happens after the open
    // (it has to -- the handle is what tells us which file we got), so the
    // open must not itself be destructive.
    const sub = join(ws, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'file.txt'), 'original-inside-content');
    writeFileSync(join(outside, 'file.txt'), ATTACKER_MARKER);

    await expect(
      __testing.openVerified(ws, 'sub/file.txt', fsConstants.O_WRONLY | fsConstants.O_CREAT, {
        __raceHooksForTests: {
          afterContainPath: () => {
            rmSync(sub, { recursive: true, force: true });
            makeJunctionOrThrow(outside, sub);
          },
        },
      })
    ).rejects.toBeInstanceOf(ToctouGuardError);

    expect(readFileSync(join(outside, 'file.txt'), 'utf8')).toBe(ATTACKER_MARKER);
  });
});

describe('TOCTOU guard (openVerified)', () => {
  it('does not false-positive on an ordinary, unraced open', async () => {
    writeFileSync(join(ws, 'a.txt'), 'hello');
    const { handle } = await __testing.openVerified(ws, 'a.txt', fsConstants.O_RDONLY);
    await handle.close();
  });

  /**
   * Runs `openVerified` with a real directory-for-junction swap landing in
   * the named window, and asserts the guard refuses. Returns nothing: any
   * failure to actually perform the swap throws.
   */
  async function expectRefusalWithSwapIn(window: 'afterContainPath' | 'afterSnapshot'): Promise<void> {
    const sub = join(ws, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'file.txt'), 'original-inside-content');
    writeFileSync(join(outside, 'file.txt'), ATTACKER_MARKER);

    let swapped = false;
    const swap = (): void => {
      rmSync(sub, { recursive: true, force: true });
      makeJunctionOrThrow(outside, sub);
      swapped = true;
    };

    const promise = __testing.openVerified(ws, 'sub/file.txt', fsConstants.O_RDONLY, {
      __raceHooksForTests: { [window]: swap },
    });

    await expect(promise).rejects.toBeInstanceOf(ToctouGuardError);
    // Non-vacuity: the attack must actually have been carried out.
    expect(swapped).toBe(true);
    // And the attacker's bytes must be unreachable through the shipped tool
    // as well, not merely through the internal helper -- with the junction
    // still in place, read_file must refuse rather than return them.
    const viaTool = (await readFileTool.execute({ path: 'sub/file.txt' }, ctx())) as Record<string, unknown>;
    expect(viaTool.error).toBe(true);
    expect(JSON.stringify(viaTool)).not.toContain(ATTACKER_MARKER);
  }

  it('refuses when the swap lands AFTER containPath -- the window the previous guard silently missed', async () => {
    // The old guard took its "before" snapshot after containPath had already
    // finished, so a swap landing here was recorded as the "before" state and
    // the post-open comparison compared the attacker's file to itself.
    await expectRefusalWithSwapIn('afterContainPath');
  });

  it('refuses when the swap lands between the snapshot and the open', async () => {
    await expectRefusalWithSwapIn('afterSnapshot');
  });

  it('refuses a read of a path that named nothing at snapshot time and then materialised', async () => {
    // The interleaving that beat the first version of the bracketing, and it
    // is one ordinary pass of a racer's cycle rather than an exotic
    // multi-toggle: the directory is briefly ABSENT (so the pre- and
    // post-containPath identities are both null and every comparison between
    // them is vacuous), then a junction to somewhere outside appears in time
    // for the open, then it is gone again by the second containment verdict.
    // Reproduced live under load before it was reproduced deterministically
    // here.
    writeFileSync(join(outside, 'inside.txt'), ATTACKER_MARKER);
    const sub = join(ws, 'sub'); // deliberately absent at snapshot time

    let materialised = false;
    const promise = __testing.openVerified(ws, 'sub/inside.txt', fsConstants.O_RDONLY, {
      __raceHooksForTests: {
        afterSnapshot: () => {
          makeJunctionOrThrow(outside, sub);
          materialised = true;
        },
      },
    });

    await expect(promise).rejects.toBeInstanceOf(ToctouGuardError);
    expect(materialised).toBe(true);
  });

  it('refuses a create whose parent materialised between the snapshot and the open', async () => {
    // Same interleaving on the write side, where O_CREAT makes "it was not
    // there a moment ago" the normal case and the parent directory is the
    // only anchor left.
    const sub = join(ws, 'sub'); // absent at snapshot time

    let materialised = false;
    const promise = __testing.openVerified(ws, 'sub/new.txt', fsConstants.O_WRONLY | fsConstants.O_CREAT, {
      __raceHooksForTests: {
        afterSnapshot: () => {
          makeJunctionOrThrow(outside, sub);
          materialised = true;
        },
      },
    });

    await expect(promise).rejects.toBeInstanceOf(ToctouGuardError);
    expect(materialised).toBe(true);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('still reports a plainly missing file as not_found, not as an attack', async () => {
    // The check above must not turn every ENOENT into a scary security error.
    const result = (await readFileTool.execute({ path: 'nowhere/at/all.txt' }, ctx())) as Record<string, unknown>;
    expect(result.code).toBe('not_found');
    const listing = (await listDirTool.execute({ path: 'no-such-dir' }, ctx())) as Record<string, unknown>;
    expect(listing.code).toBe('not_found');
  });

  it('refuses a directory listing whose directory is swapped after containPath', async () => {
    const sub = join(ws, 'sub');
    mkdirSync(sub);
    writeFileSync(join(sub, 'inside.txt'), 'inside');
    writeFileSync(join(outside, 'attacker-only.txt'), ATTACKER_MARKER);

    await expect(
      __testing.readdirVerified(ws, 'sub', {
        __raceHooksForTests: {
          afterContainPath: () => {
            rmSync(sub, { recursive: true, force: true });
            makeJunctionOrThrow(outside, sub);
          },
        },
      })
    ).rejects.toBeInstanceOf(ToctouGuardError);
  });
});

// ---------------------------------------------------------------------------
// Unhooked reproduction: a real concurrent racer
//
// No hooks, no injected seams, no cooperation from the code under test. A
// worker thread toggles `ws/sub` between a real directory and a junction
// pointing outside the workspace as fast as it can, while the main thread
// calls the shipped tools in a loop -- exactly the shape of attack a model
// with `run_command` can mount from a background process during its own turn.
//
// Against the previous implementation this leaked: read_file returned
// attacker-controlled content, write_file landed writes on a file outside the
// workspace, and list_dir enumerated an outside directory on roughly 2.4% of
// attempts. The assertions below are about OUTCOMES (did attacker bytes reach
// the caller / did our bytes reach the attacker's file), not about which
// internal check happened to fire.
// ---------------------------------------------------------------------------

interface RaceSetup {
  sub: string;
  stash: string;
  outsideDir: string;
}

/**
 * Writes the racer worker once per temp base and returns its path.
 *
 * The racer toggles `ws/sub` between a real directory and a junction that
 * points outside the workspace, as fast as the OS will let it. It has to be
 * resilient: the tools under test hold handles inside `sub`, and write_file
 * recreates `sub` (mkdir -p) whenever it finds it missing, so every step can
 * and does fail transiently. It reports what it managed to do so the test can
 * refuse to draw conclusions from a race that never actually happened.
 */
function racerScript(): string {
  const scriptPath = join(base, 'racer.cjs');
  writeFileSync(
    scriptPath,
    `const { parentPort, workerData } = require('node:worker_threads');
const { renameSync, symlinkSync, rmdirSync, rmSync, lstatSync, existsSync } = require('node:fs');
const { sub, stash, outsideDir, until } = workerData;
let swaps = 0;
const errors = Object.create(null);
function note(step, err) { const k = step + ':' + (err && err.code ? err.code : 'ERR'); errors[k] = (errors[k] || 0) + 1; }
function lstatOrNull(p) { try { return lstatSync(p); } catch { return null; } }

// Put ws/sub back to being the real directory, whatever state it is in --
// a junction we created, or an empty directory write_file's mkdir -p made
// while the real one was stashed.
function normalise() {
  // Nothing stashed => ws/sub is already the authoritative real directory.
  if (!existsSync(stash)) return;
  const st = lstatOrNull(sub);
  if (st !== null && st.isSymbolicLink()) {
    // Our own junction: rmdir removes the reparse point, never the target.
    try { rmdirSync(sub); } catch (e) { note('unlink-junction', e); return; }
  } else if (st !== null) {
    // A real directory write_file recreated (mkdir -p) while the real one
    // was stashed. Safe to delete: we just proved it is not a link.
    try { rmSync(sub, { recursive: true, force: true }); } catch (e) { note('rm-interloper', e); return; }
  }
  try { renameSync(stash, sub); } catch (e) { note('restore', e); }
}

while (Date.now() < until) {
  normalise();
  try { renameSync(sub, stash); } catch (e) { note('stash', e); continue; }
  try { symlinkSync(outsideDir, sub, 'junction'); } catch (e) { note('junction', e); continue; }
  swaps++;
  try { rmdirSync(sub); } catch (e) { note('unlink-junction', e); continue; }
  try { renameSync(stash, sub); } catch (e) { note('restore', e); }
}
normalise();
parentPort.postMessage({ swaps, errors });
`,
    'utf8'
  );
  return scriptPath;
}

interface RaceReport {
  swaps: number;
  errors: Record<string, number>;
}

/** Runs `attempt` in a loop while a racer toggles the tree; resolves with what the racer achieved. */
async function underRacer(setup: RaceSetup, durationMs: number, attempt: () => Promise<void>): Promise<RaceReport> {
  const until = Date.now() + durationMs;
  const worker = new Worker(racerScript(), {
    workerData: { sub: setup.sub, stash: setup.stash, outsideDir: setup.outsideDir, until },
  });
  const report = new Promise<RaceReport>((resolvePromise, rejectPromise) => {
    worker.once('message', (m: RaceReport) => resolvePromise(m));
    worker.once('error', rejectPromise);
  });

  while (Date.now() < until) {
    await attempt();
  }

  const result = await report;
  await worker.terminate();
  return result;
}

const RACE_MS = 3000;

describe('under a real, unhooked concurrent racer', () => {
  let setup: RaceSetup;

  beforeEach(() => {
    setup = { sub: join(ws, 'sub'), stash: join(base, 'stash'), outsideDir: outside };
    mkdirSync(setup.sub);
    writeFileSync(join(setup.sub, 'inside.txt'), 'INSIDE-CONTENT');
    writeFileSync(join(outside, 'inside.txt'), ATTACKER_MARKER);
    writeFileSync(join(outside, 'attacker-only.txt'), ATTACKER_MARKER);
  });

  it(
    'read_file never returns content from outside the workspace',
    async () => {
      let attempts = 0;
      let leaks = 0;
      const race = await underRacer(setup, RACE_MS, async () => {
        attempts++;
        const result = (await readFileTool.execute({ path: 'sub/inside.txt' }, ctx())) as Record<string, unknown>;
        if (typeof result.content === 'string' && result.content.includes(ATTACKER_MARKER)) leaks++;
      });

      // Non-vacuity first: if the racer never landed a swap, or the loop
      // barely ran, a zero leak count proves nothing at all.
      expect({ ...race, attempts, leaks }).toMatchObject({ leaks: 0 });
      expect(race.swaps).toBeGreaterThan(0);
      expect(attempts).toBeGreaterThan(100);
    },
    RACE_MS + 20_000
  );

  it(
    'write_file never lands a write on a file outside the workspace',
    async () => {
      let attempts = 0;
      const payload = 'WRITTEN-BY-A-CONTAINED-TOOL';
      const race = await underRacer(setup, RACE_MS, async () => {
        attempts++;
        // A millisecond of breathing room per attempt: write_file holds a
        // handle inside `sub` and recreates it via mkdir -p, and a
        // back-to-back loop keeps the directory busy enough that the racer
        // cannot land a single swap (measured: 2 swaps in 1405 attempts
        // without this, 205 in 211 with it). A model retrying in a loop is
        // not back-to-back either.
        await new Promise((r) => setTimeout(r, 1));
        await writeFileTool.execute({ path: 'sub/inside.txt', content: payload }, ctx());
      });

      // The outside file must still hold the attacker's own bytes: neither
      // overwritten with our payload, nor truncated on the way to a refusal.
      expect({ ...race, attempts, outside: readFileSync(join(outside, 'inside.txt'), 'utf8') }).toMatchObject({
        outside: ATTACKER_MARKER,
      });
      // Floors, not targets: measured ~211 attempts and ~205 landed swaps
      // here. Low enough to survive a loaded machine (this loop paces itself
      // at 1ms, so it does far fewer attempts than the read/list races), high
      // enough that a race which never happened cannot masquerade as a race
      // that found nothing.
      expect(race.swaps).toBeGreaterThan(0);
      expect(attempts).toBeGreaterThan(20);
    },
    RACE_MS + 20_000
  );

  it(
    'list_dir enumerates outside the workspace far less often, but this is a NARROWING and not a fix',
    async () => {
      // Honest assertion. list_dir holds no handle -- Node exposes no
      // fd-based readdir -- so a swap that lands and is reverted entirely
      // within the readdir call is undetectable, and a model that retries in
      // a loop will eventually hit it. The previous implementation leaked on
      // ~2.4% of attempts (977 of 39,993 in the reviewer's run). The bound
      // below is deliberately far above zero and far below that: it is a
      // regression fence, not a claim of safety.
      let attempts = 0;
      let leaks = 0;
      const race = await underRacer(setup, RACE_MS, async () => {
        attempts++;
        const result = (await listDirTool.execute({ path: 'sub' }, ctx())) as Record<string, unknown>;
        const entries = (result.entries as { name: string }[] | undefined) ?? [];
        if (entries.some((e) => e.name === 'attacker-only.txt')) leaks++;
      });

      const rate = leaks / attempts;
      expect({ ...race, attempts, leaks, rate }).toMatchObject({});
      expect(race.swaps).toBeGreaterThan(0);
      expect(attempts).toBeGreaterThan(100);
      expect(rate).toBeLessThan(0.005);
    },
    RACE_MS + 20_000
  );
});
