import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { containPath, PathEscapeError } from '../src/domain/paths.js';

let root: string, outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'grunt-paths-'));
  root = join(base, 'ws'); outside = join(base, 'outside');
  mkdirSync(root); mkdirSync(outside);
  writeFileSync(join(root, 'ok.txt'), 'ok');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
});
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

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
    // An embedded NUL is treated as a string terminator by some OS-level path
    // probes (e.g. existsSync on Windows) but not by others, so a candidate
    // like "<root>\ok.txt\0<absolute outside path>" can look validly
    // contained under naive string comparison while its OS-level meaning is
    // ambiguous. Reject outright rather than trust it.
    const smuggled = join(root, 'ok.txt') + '\0' + join(outside, 'secret.txt');
    expect(() => containPath(root, smuggled)).toThrow(PathEscapeError);
  });

  it('throws PathEscapeError (not a raw Node error) for an unresolvable candidate', () => {
    // A Windows extended-length-prefixed path to a real in-workspace file
    // trips a Node realpathSync quirk (EISDIR) rather than resolving. The
    // security boundary must fail closed with its own typed error, not leak
    // an arbitrary internal exception to callers that only catch
    // PathEscapeError.
    const extendedLength = '\\\\?\\' + join(root, 'ok.txt');
    expect(() => containPath(root, extendedLength)).toThrow(PathEscapeError);
  });
});
