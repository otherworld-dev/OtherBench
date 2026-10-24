import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The desktop app's page policy (desktop/src-tauri/tauri.conf.json). With a token the web UI fetches generated
// images and videos and shows them through blob: URLs (AuthedImage, GeneratedMedia), so both kinds need blob:.
const conf = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../desktop/src-tauri/tauri.conf.json'), 'utf8')) as {
  app: { security: { csp: string } };
};

function directive(name: string): string[] {
  const part = conf.app.security.csp.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${name} `));
  return part ? part.split(/\s+/).slice(1) : [];
}

describe('desktop CSP', () => {
  it('lets images and videos play from blob: URLs', () => {
    expect(directive('img-src')).toContain('blob:');
    expect(directive('media-src')).toContain('blob:');
  });
});
