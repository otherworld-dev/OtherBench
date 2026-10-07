import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, parse } from 'node:path';
import { containPath, containPathIn, PathEscapeError } from '../src/domain/paths.js';

let root: string, outside: string, base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'grunt-paths-'));
  root = join(base, 'ws'); outside = join(base, 'outside');
  mkdirSync(root); mkdirSync(outside);
  writeFileSync(join(root, 'ok.txt'), 'ok');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
});
// Remove the whole temp base, not just root: root's sibling `outside` and
// `secret.txt` were leaking into the OS tmpdir on every run otherwise,
// which also meant runs weren't independent of leftovers from prior runs.
afterAll(() => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

describe('containPath', () => {
  it('accepts a file directly inside the workspace', () => {
    expect(containPath(root, join(root, 'ok.txt'))).toBe(join(root, 'ok.txt'));
  });

  it('accepts a relative path resolved against the workspace', () => {
    expect(containPath(root, 'ok.txt')).toBe(join(root, 'ok.txt'));
  });

  it('rejects parent traversal', () => {
    expect(() => containPath(root, join(root, '..', 'outside', 'secret.txt')))
      .toThrow(PathEscapeError);
  });

  it('rejects encoded traversal that resolves outside', () => {
    expect(() => containPath(root, '../outside/secret.txt')).toThrow(PathEscapeError);
  });

  it('rejects an absolute path outside the workspace', () => {
    expect(() => containPath(root, join(outside, 'secret.txt'))).toThrow(PathEscapeError);
  });

  it('rejects a symlink pointing outside the workspace', () => {
    const link = join(root, 'escape');
    try { symlinkSync(outside, link, 'junction'); } catch { return; } // needs privilege on Windows
    expect(() => containPath(root, join(link, 'secret.txt'))).toThrow(PathEscapeError);
  });

  it('rejects a sibling directory sharing a name prefix', () => {
    // /tmp/x/ws-evil must not pass a prefix check against /tmp/x/ws
    expect(() => containPath(root, root + '-evil' + sep + 'f.txt')).toThrow(PathEscapeError);
  });

  it('rejects everything when workspaceRoot is null', () => {
    expect(() => containPath(null, join(root, 'ok.txt'))).toThrow(PathEscapeError);
  });

  it('accepts a not-yet-existing file inside the workspace, resolving its nearest existing ancestor', () => {
    const target = join(root, 'new-dir', 'new-file.txt');
    expect(containPath(root, target)).toBe(target);
  });

  it('accepts and normalises a forward-slash path on any platform', () => {
    const target = root + '/sub/f.txt';
    expect(containPath(root, target)).toBe(join(root, 'sub', 'f.txt'));
  });

  it('rejects a candidate containing an embedded NUL byte', () => {
    // A NUL byte makes every OS-level existence probe on the segment that
    // contains it report "not present" (Node validates and rejects NUL
    // paths internally) even though the segment is, character for
    // character, part of the string. That is the SAME defect the
    // dangling-link tests below exercise: the nearest-existing-ancestor
    // climb walks past whatever it cannot confirm and blindly copies it
    // into the resolved tail, unvalidated, rather than treating "cannot
    // confirm" as "cannot trust". The upfront guard below stays even after
    // the climb walks through lstat: lstat rejects NUL paths the same way,
    // so without this explicit check the climb would still walk past the
    // NUL-bearing segment and reconstruct it into an ostensibly-contained
    // path via the very same mechanism.
    const smuggled = join(root, 'ok.txt') + '\0' + join(outside, 'secret.txt');
    expect(() => containPath(root, smuggled)).toThrow(PathEscapeError);
  });

  it.skipIf(process.platform !== 'win32')(
    'throws PathEscapeError (not a raw Node error) for a Windows extended-length-prefixed candidate',
    () => {
      // Regression test for a specific Windows/Node quirk: realpathSync
      // throws a raw EISDIR for \\?\-prefixed paths instead of resolving
      // them, even for a real in-workspace file. Windows-only because on
      // POSIX '\\?\...' has no special meaning and is just a relative path
      // whose components don't exist, which correctly falls into the
      // ordinary "write to a new path" acceptance case instead. The
      // platform-neutral form of the underlying contract -- that any
      // internal resolution failure surfaces as PathEscapeError and never a
      // raw error -- is covered by the dangling-link tests below, which
      // exercise the same catch-all on every platform.
      const extendedLength = '\\\\?\\' + join(root, 'ok.txt');
      expect(() => containPath(root, extendedLength)).toThrow(PathEscapeError);
    }
  );

  it('rejects a dangling junction/symlink candidate, even though its literal path text looks contained', () => {
    // Critical regression: existsSync follows links and reports false for
    // one whose target doesn't currently exist, so the ancestor climb used
    // to walk straight past a dangling link and copy its name verbatim into
    // the resolved tail -- never once handing it to realpathSync. The
    // returned path was blessed as "contained" while being, by the
    // function's own contract, unresolved: a real write/read using that
    // exact returned value follows the link at the OS level and lands
    // outside the workspace. npm-workspaces repos routinely have
    // node_modules junctions/symlinks that dangle mid-install or mid-rename,
    // so this isn't a contrived input.
    const link = join(root, 'dangling');
    const missingTarget = join(outside, 'not-created-yet');
    try { symlinkSync(missingTarget, link, 'junction'); } catch { return; } // needs privilege on Windows
    expect(() => containPath(root, join(link, 'owned.txt'))).toThrow(PathEscapeError);
  });

  it('accepts a symlink/junction that points inside the workspace, including a new file reached through it', () => {
    // Regression guard for the fix above: stopping the climb at any present
    // link (instead of walking past it) must not over-rotate into denying
    // links whose target is legitimately inside the workspace -- including
    // the not-yet-existing-file case the brief requires (a write through
    // such a link to a brand new file must still succeed).
    const realDir = join(root, 'realdir');
    mkdirSync(realDir);
    const link = join(root, 'inlink');
    try { symlinkSync(realDir, link, 'junction'); } catch { return; } // needs privilege on Windows
    const target = join(link, 'brand-new.txt'); // does not exist yet
    expect(containPath(root, target)).toBe(join(realDir, 'brand-new.txt'));
  });

  it('does not corrupt the filename when the workspace root is a filesystem root', () => {
    // dirname() returns a path WITH a trailing separator at every root form
    // (drive root, UNC share root, POSIX root) but nowhere else. Slicing
    // `cur` at `parent.length + 1` assumed a separator always needs
    // skipping, which ate the candidate's first character whenever the
    // parent was itself a root (e.g. containPath('C:\\', 'newfile.txt') used
    // to return 'C:\\ewfile.txt'). basename() has no such assumption.
    const driveRoot = parse(root).root;
    const uniqueName = `grunt-root-probe-${Date.now()}.txt`;
    expect(containPath(driveRoot, uniqueName)).toBe(join(driveRoot, uniqueName));
  });
});

describe('containPathIn (extra folders)', () => {
  let ws: string, refs: string, notes: string, vendor: string, elsewhere: string;
  beforeAll(() => {
    const b = mkdtempSync(join(tmpdir(), 'grunt-folders-'));
    ws = join(b, 'project'); refs = join(b, 'refs'); notes = join(b, 'notes'); elsewhere = join(b, 'elsewhere');
    vendor = join(ws, 'vendor');
    for (const d of [ws, refs, notes, elsewhere, vendor]) mkdirSync(d, { recursive: true });
    writeFileSync(join(refs, 'paper.md'), 'p');
    writeFileSync(join(elsewhere, 'secret.txt'), 's');
  });
  const folders = () => [
    { root: refs, access: 'read' as const },
    { root: notes, access: 'readwrite' as const },
    { root: vendor, access: 'read' as const },
  ];

  it('keeps relative paths in the workspace, which is writable', () => {
    expect(containPathIn(ws, folders(), 'src/a.ts')).toEqual({ path: join(ws, 'src', 'a.ts'), root: ws, writable: true });
  });

  it('finds an absolute path in an extra folder, with that folder\'s access', () => {
    expect(containPathIn(ws, folders(), join(refs, 'paper.md'))).toEqual({ path: join(refs, 'paper.md'), root: refs, writable: false });
    expect(containPathIn(ws, folders(), join(notes, 'n.md'))).toEqual({ path: join(notes, 'n.md'), root: notes, writable: true });
  });

  it('gives a folder nested in the workspace its own access, however the path is written', () => {
    expect(containPathIn(ws, folders(), join(vendor, 'lib.js')).writable).toBe(false);
    expect(containPathIn(ws, folders(), 'vendor/lib.js')).toEqual({ path: join(vendor, 'lib.js'), root: vendor, writable: false });
  });

  it('refuses a path in none of the folders, and traversal out of an extra folder', () => {
    expect(() => containPathIn(ws, folders(), join(elsewhere, 'secret.txt'))).toThrow(PathEscapeError);
    expect(() => containPathIn(ws, folders(), join(refs, '..', 'elsewhere', 'secret.txt'))).toThrow(PathEscapeError);
    expect(() => containPathIn(ws, folders(), '../elsewhere/secret.txt')).toThrow(PathEscapeError);
  });

  it('refuses a link inside an extra folder that points outside every folder', () => {
    const link = join(notes, 'escape');
    try { symlinkSync(elsewhere, link, 'junction'); } catch { return; } // needs privilege on Windows
    expect(() => containPathIn(ws, folders(), join(link, 'secret.txt'))).toThrow(PathEscapeError);
  });

  it('refuses everything without a workspace, extra folders or not', () => {
    expect(() => containPathIn(null, folders(), join(refs, 'paper.md'))).toThrow(PathEscapeError);
  });
});
