import { describe, expect, it, vi } from 'vitest';
import { loadNodePty } from '../../src/terminal/node-pty.js';

describe('loadNodePty', () => {
  it("is null on Windows when the prebuilt ConPTY binary can't load, though the package imports", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawn = await loadNodePty({
      platform: 'win32',
      importPty: async () => ({ spawn: () => ({}) as never }),
      requireNative: () => {
        throw new Error("Cannot find module '@lydell/node-pty-win32-x64/conpty.node'");
      },
    });
    expect(spawn).toBeNull();
    warn.mockRestore();
  });

  it('loads when the binary is there', async () => {
    const spawn = await loadNodePty({ platform: 'win32', importPty: async () => ({ spawn: () => ({}) as never }), requireNative: () => ({}) });
    expect(typeof spawn).toBe('function');
  });
});
