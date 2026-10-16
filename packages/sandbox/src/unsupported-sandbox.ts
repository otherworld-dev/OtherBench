import { SandboxError, type Sandbox, type SandboxRunResult, type SandboxStatus } from '@otherbench/core/ports/sandbox.js';

const MESSAGE = "The sandbox isn't available on this platform yet.";

/** Every platform but Windows, for now (a Linux backend is phase 2 of spec 2026-10-12-sandbox-design). */
export class UnsupportedSandbox implements Sandbox {
  constructor(private readonly machineName: () => string = () => 'this machine') {}

  async status(): Promise<SandboxStatus> {
    return { state: 'unsupported', detail: MESSAGE, packages: [], machine: this.machineName() };
  }

  async setup(): Promise<void> {
    throw new SandboxError('unsupported', MESSAGE);
  }

  async remove(): Promise<void> {
    throw new SandboxError('unsupported', MESSAGE);
  }

  async setPackages(): Promise<void> {
    throw new SandboxError('unsupported', MESSAGE);
  }

  async run(): Promise<SandboxRunResult> {
    throw new SandboxError('unsupported', MESSAGE);
  }

  async release(): Promise<void> {}

  async close(): Promise<void> {}
}
