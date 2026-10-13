import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sandboxResourcesDir } from '../src/resources.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('sandboxResourcesDir', () => {
  it('finds packages/sandbox/resources from the compiled package (dev)', () => {
    const dir = sandboxResourcesDir(join(here, '..', 'dist'));
    expect(dir).toBe(join(here, '..', 'resources'));
    expect(existsSync(join(dir, 'agent.mjs'))).toBe(true);
  });

  it('finds sandbox/ beside the bundled server', () => {
    const bundle = mkdtempSync(join(tmpdir(), 'grunt-bundle-'));
    try {
      mkdirSync(join(bundle, 'sandbox'));
      writeFileSync(join(bundle, 'sandbox', 'agent.mjs'), '');
      expect(sandboxResourcesDir(bundle)).toBe(join(bundle, 'sandbox'));
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });

  it('says where it looked when the files are missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'grunt-nowhere-'));
    try {
      expect(() => sandboxResourcesDir(join(empty, 'dist'))).toThrow(/agent\.mjs/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
