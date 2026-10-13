import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SandboxPathError, toSandboxPath } from '@grunt/core/domain/sandbox-paths.js';
import { hasBash, runMountScriptWithEnvPaths as runMountScript } from './helpers.js';

/**
 * One table of Windows paths, run against both implementations of the path rules: toSandboxPath
 * in core (what Grunt plans with) and mount.sh (the strict gate that runs as root). They must
 * accept and refuse exactly the same paths and agree on where an accepted one is mounted.
 */
interface Vector {
  name: string;
  windows: string;
  /** What is passed to mount.sh as the Linux path (for a refused path, the one a lenient mapping would give). */
  target: string;
  /** Where the folder is mounted, or null if it must be refused. */
  linux: string | null;
}

/** `{a*1021}` stands for 1021 letters a. */
const expand = (text: string): string => text.replace(/\{(.)\*(\d+)\}/g, (_m, ch: string, n: string) => ch.repeat(Number(n)));

const vectors = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sandbox-path-vectors.json'), 'utf8')) as Vector[]).map((v) => ({
  ...v,
  windows: expand(v.windows),
  target: expand(v.target),
  linux: v.linux === null ? null : expand(v.linux),
}));

describe('the shared path vectors', () => {
  it('has both kinds of vector', () => {
    expect(vectors.filter((v) => v.linux !== null).length).toBeGreaterThan(8);
    expect(vectors.filter((v) => v.linux === null).length).toBeGreaterThan(20);
  });

  describe('toSandboxPath', () => {
    it.each(vectors)('$name', (v) => {
      if (v.linux === null) expect(() => toSandboxPath(v.windows)).toThrow(SandboxPathError);
      else expect(toSandboxPath(v.windows)).toBe(v.linux);
    });
  });

  describe.skipIf(!hasBash)('mount.sh', () => {
    it.each(vectors)('$name', (v) => {
      const r = runMountScript(v.windows, v.target);
      if (v.linux === null) {
        expect(r.code, r.err).toBe(2);
        // Refused for the path's own sake, not just because the target didn't match.
        expect(r.err).not.toMatch(/doesn't match/);
        expect(r.out).not.toContain('mount|-t');
      } else {
        expect(r.err).toBe('');
        expect(r.code).toBe(0);
        expect(r.out.split('\n')).toContain(`mount|-t|drvfs|-o|ro,uid=UID,gid=GID|--|${v.windows}|${v.linux}|`);
      }
    });

    it('mounts an accepted path where toSandboxPath says, and nowhere else', () => {
      for (const v of vectors.filter((x) => x.linux !== null)) {
        expect(runMountScript(v.windows, `${toSandboxPath(v.windows)}x`).code, v.name).toBe(2);
      }
    });
  });
});
