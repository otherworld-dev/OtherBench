import { describe, expect, it, vi } from 'vitest';
import { FakeSandbox, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { UnsupportedSandbox } from '@otherbench/sandbox/unsupported-sandbox.js';
import { WslSandbox } from '@otherbench/sandbox/wsl-sandbox.js';
import { createSandbox } from '../src/sandbox.js';

const deps = (over: Partial<Parameters<typeof createSandbox>[0]> = {}) => ({ store: new InMemoryStore(), dataDir: 'C:\\otherbench-data', serverPort: () => null, env: {}, ...over });

describe('createSandbox', () => {
  it('gives the e2e server a FakeSandbox under OTHERBENCH_SANDBOX=fake, and says so loudly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await createSandbox(deps({ env: { OTHERBENCH_SANDBOX: 'fake' }, platform: 'linux' }))).toBeInstanceOf(FakeSandbox);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/OTHERBENCH_SANDBOX=fake[\s\S]*NOT isolated/);
    } finally {
      warn.mockRestore();
    }
  });

  it('is unsupported off Windows, with no warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const sandbox = await createSandbox(deps({ platform: 'linux' }));
      expect(sandbox).toBeInstanceOf(UnsupportedSandbox);
      expect((await sandbox.status()).state).toBe('unsupported');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('is the WSL sandbox on Windows, keeping its state in app_setting "sandbox"', async () => {
    const store = new InMemoryStore();
    store.settings.setValue('sandbox', { state: 'failed', packages: ['ffmpeg'], detail: 'Install Node: no network' });
    const sandbox = await createSandbox(deps({ store, platform: 'win32' }));
    expect(sandbox).toBeInstanceOf(WslSandbox);
    expect(await sandbox.status()).toMatchObject({ state: 'failed', detail: 'Install Node: no network', packages: ['ffmpeg'], machine: 'This machine' });
  });

  it('treats a damaged stored state as not set up', async () => {
    const store = new InMemoryStore();
    store.settings.setValue('sandbox', { nonsense: true });
    expect((await (await createSandbox(deps({ store, platform: 'win32' }))).status()).state).toBe('not_set_up');
  });
});
