import { join } from 'node:path';
import { isStoredSandboxState, SANDBOX_SETTING_KEY, type Sandbox } from '@grunt/core/ports/sandbox.js';
import type { Store } from '@grunt/core/ports/store.js';
import { sandboxResourcesDir } from '@grunt/sandbox/resources.js';
import { UnsupportedSandbox } from '@grunt/sandbox/unsupported-sandbox.js';
import { WslSandbox } from '@grunt/sandbox/wsl-sandbox.js';
import { createWslRunner } from '@grunt/sandbox/wsl.js';

export interface SandboxDeps {
  store: Store;
  /** Where Grunt keeps its files on this machine (the self-test's folders go under it). */
  dataDir: string;
  /** The port Grunt serves on, once known (the self-test checks the VM can't reach it). */
  serverPort: () => number | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * This machine's sandbox (spec 2026-10-12-sandbox-design): the WSL one on
 * Windows, refusals elsewhere, and a FakeSandbox under GRUNT_SANDBOX=fake
 * (the e2e server). Its state is machine-local: app_setting "sandbox".
 * Nothing here sets it up: setup only ever starts from Settings > Sandbox.
 */
export async function createSandbox(deps: SandboxDeps): Promise<Sandbox> {
  const env = deps.env ?? process.env;
  const machineName = (): string => deps.store.nodes.self().name;
  if (env['GRUNT_SANDBOX'] === 'fake') {
    // Only the e2e run sets this; a server that has it by accident would report commands as run in a sandbox when nothing ran at all.
    console.warn('[grunt-server] GRUNT_SANDBOX=fake: the sandbox is a FAKE. Sandboxed commands are NOT isolated, nor run at all. This is for the e2e tests only; unset it.');
    // Loaded here, not at the top: the fakes are test support and only this switch wants them.
    const { FakeSandbox } = await import('@grunt/core/testing/fakes.js');
    return new FakeSandbox({ machine: machineName });
  }
  if ((deps.platform ?? process.platform) !== 'win32') return new UnsupportedSandbox(machineName);
  return new WslSandbox({
    runner: createWslRunner(),
    resourcesDir: () => sandboxResourcesDir(),
    state: {
      get: () => {
        const value = deps.store.settings.getValue(SANDBOX_SETTING_KEY);
        return isStoredSandboxState(value) ? value : null;
      },
      set: (state) => deps.store.settings.setValue(SANDBOX_SETTING_KEY, state),
    },
    machineName,
    gruntPort: deps.serverPort,
    selfTestDir: join(deps.dataDir, 'sandbox-selftest'),
  });
}
