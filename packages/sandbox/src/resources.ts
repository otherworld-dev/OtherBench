import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the files setup copies into the VM are (agent.mjs, agent-core.mjs,
 * mount.sh, wsl.conf, package.json, package-lock.json). In the bundled server
 * (packages/server/scripts/bundle.mjs) they are `sandbox/` beside cli.js, and
 * `import.meta.url` is cli.js itself; in dev they are packages/sandbox/resources,
 * beside this package's dist/. Throws, saying where it looked, when neither has them.
 */
export function sandboxResourcesDir(here: string = dirname(fileURLToPath(import.meta.url))): string {
  const candidates = [join(here, 'sandbox'), join(here, '..', 'resources')];
  const found = candidates.find((c) => existsSync(join(c, 'agent.mjs')));
  if (!found) throw new Error(`Grunt's sandbox files (agent.mjs) weren't found in ${candidates.join(' or ')}.`);
  return found;
}
