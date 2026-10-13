import { describe, expect, it } from 'vitest';
import { isSandboxError, isStoredSandboxState, SANDBOX_MAX_OUTPUT_BYTES, SandboxError } from '../src/ports/sandbox.js';
import { DEFAULT_SANDBOX_HOSTS, runsShellInSandbox, sandboxHostsOf, type ToolPolicy } from '../src/types/config.js';

const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate', ...o });

describe('sandbox policy fields', () => {
  it('runs the shell in the sandbox only when shell is on and shellRuns is "sandbox"', () => {
    expect(runsShellInSandbox(policy({ shellRuns: 'sandbox' }))).toBe(true);
    expect(runsShellInSandbox(policy({ shellRuns: 'sandbox', shell: false }))).toBe(false);
    expect(runsShellInSandbox(policy({ shellRuns: 'host' }))).toBe(false);
    expect(runsShellInSandbox(policy())).toBe(false);
  });

  it('uses the default allowlist unless the profile has its own, and hands out a copy', () => {
    expect(DEFAULT_SANDBOX_HOSTS).toEqual([
      'registry.npmjs.org',
      'pypi.org',
      'files.pythonhosted.org',
    ]);
    for (const host of DEFAULT_SANDBOX_HOSTS) expect(host).not.toMatch(/github/);
    const hosts = sandboxHostsOf(policy());
    expect(hosts).toEqual([...DEFAULT_SANDBOX_HOSTS]);
    hosts.push('evil.example');
    expect(DEFAULT_SANDBOX_HOSTS).not.toContain('evil.example');
    expect(sandboxHostsOf(policy({ sandboxHosts: ['example.org'] }))).toEqual(['example.org']);
    // A profile that names GitHub itself keeps it: only the default changed.
    expect(sandboxHostsOf(policy({ sandboxHosts: ['github.com', 'pypi.org'] }))).toEqual(['github.com', 'pypi.org']);
    expect(sandboxHostsOf(policy({ sandboxHosts: [] }))).toEqual([]);
  });
});

describe('SandboxError', () => {
  it('carries a code, and is recognised by name and code (a second copy of core still counts)', () => {
    const err = new SandboxError('busy', 'Try again.');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('busy');
    expect(isSandboxError(err)).toBe(true);
    expect(isSandboxError(Object.assign(new Error('x'), { name: 'SandboxError', code: 'not_set_up' }))).toBe(true);
    expect(isSandboxError(new Error('x'))).toBe(false);
    expect(isSandboxError('SandboxError')).toBe(false);
  });

  it('caps output at 100 KB, as run_command does on the host', () => {
    expect(SANDBOX_MAX_OUTPUT_BYTES).toBe(100 * 1024);
  });
});

describe('isStoredSandboxState', () => {
  it('accepts what WslSandbox stores and nothing else', () => {
    expect(isStoredSandboxState({ state: 'ready', packages: [], versions: { distro: 'Ubuntu 24.04.5 LTS', runtime: '0.0.79', node: 'v24.21.0' } })).toBe(true);
    expect(isStoredSandboxState({ state: 'failed', packages: ['ffmpeg'], detail: 'Install Node: no network' })).toBe(true);
    expect(isStoredSandboxState({ state: 'not_set_up', packages: [] })).toBe(true);
    expect(isStoredSandboxState({ state: 'setting_up', packages: [] })).toBe(false);
    expect(isStoredSandboxState({ state: 'ready' })).toBe(false);
    expect(isStoredSandboxState({ state: 'ready', packages: [1] })).toBe(false);
    expect(isStoredSandboxState(null)).toBe(false);
  });
});
