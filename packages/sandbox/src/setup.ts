import type { SandboxVersions } from '@grunt/core/ports/sandbox.js';
import { DISTRO, type WslResult, type WslRunner, type WslUser } from './wsl.js';

/** `wsl --install <distro> --name` arrived in WSL 2.4 (spec 2026-10-12-sandbox-design). */
export const MIN_WSL = [2, 4, 0] as const;
export const NODE_VERSION = 'v24.21.0';
export const NODE_TARBALL = `node-${NODE_VERSION}-linux-x64.tar.xz`;
export const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}`;
export const NODE_SHA256 = 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6';
export const INSTALL_DIR = '/opt/grunt-sandbox';
/** Where Grunt's sandbox/ resource folder is mounted, read-only, while setup copies files in. */
export const SETUP_MOUNT = '/mnt/grunt-setup';
export const BASE_PACKAGES = [
  'bubblewrap',
  'socat',
  'ripgrep',
  'git',
  'curl',
  'ca-certificates',
  'xz-utils',
  'unzip',
  'jq',
  'iproute2',
  'python3',
  'python3-pip',
  'python3-venv',
  'build-essential',
];
/** Copied from the resource folder into INSTALL_DIR, root-owned. */
export const RESOURCE_FILES: readonly { name: string; mode: string }[] = [
  { name: 'agent.mjs', mode: '0644' },
  { name: 'agent-core.mjs', mode: '0644' },
  { name: 'package.json', mode: '0644' },
  { name: 'package-lock.json', mode: '0644' },
  { name: 'mount.sh', mode: '0755' },
];

export class SetupError extends Error {
  constructor(
    readonly step: string,
    message: string
  ) {
    super(message);
    this.name = 'SetupError';
  }
}

export interface SetupContext {
  runner: WslRunner;
  /** Grunt's sandbox resource folder, as a Windows drive-letter path. */
  resourcesDir: string;
  /** Extra apt packages from Settings. */
  packages: string[];
  log(line: string): void;
  /** The self-test (selftest.ts), run through the real agents. Throws on a surprise. */
  selfTest(): Promise<void>;
}

export interface SetupStep {
  name: string;
  run(ctx: SetupContext): Promise<void>;
}

const MINUTE = 60_000;
const textOf = (r: WslResult): string => `${r.stdout}\n${r.stderr}`.replace(/\0/g, '').trim();

/** Runs a program in the distro and throws SetupError for this step when it fails. */
async function must(ctx: SetupContext, step: string, label: string, argv: string[], timeoutMs = 2 * MINUTE, user: WslUser = 'root'): Promise<WslResult> {
  const r = await ctx.runner.exec(user, argv, { timeoutMs });
  if (r.code !== 0) {
    const why = textOf(r).slice(-1500) || `exit ${String(r.code)}`;
    throw new SetupError(step, `${label} failed${r.timedOut ? ' (timed out)' : ''}: ${why}`);
  }
  return r;
}

/** Mounts the resource folder read-only for `fn`, and always unmounts it again. */
async function withResources(ctx: SetupContext, step: string, fn: () => Promise<void>): Promise<void> {
  await must(ctx, step, 'Making the setup mount point', ['/bin/mkdir', '-p', SETUP_MOUNT]);
  await ctx.runner.exec('root', ['/bin/umount', SETUP_MOUNT]); // a leftover from an interrupted setup; failing is normal
  await must(ctx, step, `Mounting Grunt's sandbox files (${ctx.resourcesDir})`, ['/bin/mount', '-t', 'drvfs', ctx.resourcesDir, SETUP_MOUNT, '-o', 'ro']);
  try {
    await fn();
  } finally {
    await ctx.runner.exec('root', ['/bin/umount', SETUP_MOUNT]);
  }
}

export function parseWslVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i += 1) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** `wsl --list --quiet` as names. */
export function distroNames(listOutput: string): string[] {
  return listOutput
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const apt = (args: string[]): string[] => ['/usr/bin/env', 'DEBIAN_FRONTEND=noninteractive', '/usr/bin/apt-get', ...args];

/** A Debian package name (lower case letters, digits, + - .; starts with a letter or digit). apt runs as root, so a name that looks like an option (`-o ...`) must never reach it. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*$/;
export function assertPackageNames(packages: readonly string[]): void {
  const bad = packages.find((p) => !PACKAGE_NAME.test(p));
  if (bad !== undefined) throw new Error(`"${bad}" is not an apt package name.`);
}

const checkWsl: SetupStep = {
  name: 'Check WSL',
  async run(ctx) {
    const r = await ctx.runner.wsl(['--version'], { timeoutMs: MINUTE });
    const v = r.code === 0 ? parseWslVersion(textOf(r)) : null;
    if (!v) {
      throw new SetupError(this.name, "WSL isn't installed, or is too old to report its version. In PowerShell run `wsl --install` (or `wsl --update`), restart Windows if it asks, then press Set up again.");
    }
    if (!atLeast(v, MIN_WSL)) {
      throw new SetupError(this.name, `WSL ${v.join('.')} is too old: the sandbox needs 2.4 or later. Run \`wsl --update\`, then press Repair.`);
    }
    ctx.log(`WSL ${v.join('.')}`);
  },
};

const createDistro: SetupStep = {
  name: 'Create the distro',
  async run(ctx) {
    const list = await ctx.runner.wsl(['--list', '--quiet'], { timeoutMs: MINUTE });
    if (distroNames(list.stdout).some((n) => n.toLowerCase() === DISTRO)) {
      ctx.log(`${DISTRO} already exists: repairing it.`);
      return;
    }
    const r = await ctx.runner.wsl(['--install', 'Ubuntu-24.04', '--name', DISTRO, '--no-launch'], { timeoutMs: 30 * MINUTE });
    if (r.code !== 0) throw new SetupError(this.name, `Creating the ${DISTRO} distro failed: ${textOf(r).slice(-1500)}`);
  },
};

const configureDistro: SetupStep = {
  name: 'Configure the distro',
  async run(ctx) {
    await withResources(ctx, this.name, async () => {
      await must(ctx, this.name, 'Writing /etc/wsl.conf', ['/usr/bin/install', '-o', 'root', '-g', 'root', '-m', '0644', `${SETUP_MOUNT}/wsl.conf`, '/etc/wsl.conf']);
    });
    const t = await ctx.runner.wsl(['--terminate', DISTRO], { timeoutMs: MINUTE });
    if (t.code !== 0) throw new SetupError(this.name, `Restarting the distro failed: ${textOf(t)}`);
    // The next command starts it again with the new wsl.conf: no WSLInterop entry means no Windows programs.
    const interop = await ctx.runner.exec('root', ['/usr/bin/test', '-e', '/proc/sys/fs/binfmt_misc/WSLInterop'], { timeoutMs: 2 * MINUTE });
    if (interop.code === 0) {
      throw new SetupError(this.name, 'Windows interop is still on inside the distro after restarting it, so a command could start Windows programs. Check /etc/wsl.conf in the grunt-sandbox distro, then press Repair.');
    }
  },
};

const installPackages: SetupStep = {
  name: 'Install packages',
  async run(ctx) {
    try {
      assertPackageNames(ctx.packages);
    } catch (err) {
      throw new SetupError(this.name, err instanceof Error ? err.message : String(err));
    }
    await must(ctx, this.name, 'apt-get update', apt(['update', '-q']), 15 * MINUTE);
    await must(ctx, this.name, 'apt-get install', apt(['install', '-y', '-q', ...BASE_PACKAGES, ...ctx.packages]), 45 * MINUTE);
    const id = await ctx.runner.exec('root', ['/usr/bin/id', '-u', 'grunt']);
    if (id.code !== 0) await must(ctx, this.name, 'Adding the grunt user', ['/usr/sbin/useradd', '-m', '-s', '/bin/bash', 'grunt']);
    await must(ctx, this.name, "Making the chats' home folder", ['/usr/bin/install', '-d', '-o', 'grunt', '-g', 'grunt', '-m', '0700', '/home/grunt/chats']);
  },
};

const installNode: SetupStep = {
  name: 'Install Node',
  async run(ctx) {
    const node = `${INSTALL_DIR}/node/bin/node`;
    const have = await ctx.runner.exec('root', [node, '--version']);
    if (have.code === 0 && have.stdout.trim() === NODE_VERSION) {
      ctx.log(`Node ${NODE_VERSION} is already installed.`);
      return;
    }
    const tarball = '/tmp/grunt-node.tar.xz';
    await must(ctx, this.name, `Downloading ${NODE_TARBALL}`, ['/usr/bin/curl', '-fsSL', '--retry', '3', '-o', tarball, NODE_URL], 15 * MINUTE);
    const sum = await must(ctx, this.name, 'Checking the download', ['/usr/bin/sha256sum', tarball]);
    if (sum.stdout.trim().split(/\s+/)[0] !== NODE_SHA256) {
      await ctx.runner.exec('root', ['/bin/rm', '-f', tarball]);
      throw new SetupError(this.name, `The Node download didn't match its pinned SHA-256 (${NODE_SHA256}), so it wasn't installed.`);
    }
    await must(ctx, this.name, 'Removing the old Node', ['/bin/rm', '-rf', `${INSTALL_DIR}/node`]);
    await must(ctx, this.name, 'Making the Node folder', ['/bin/mkdir', '-p', `${INSTALL_DIR}/node`]);
    await must(ctx, this.name, 'Unpacking Node', ['/bin/tar', '-xJf', tarball, '-C', `${INSTALL_DIR}/node`, '--strip-components=1'], 10 * MINUTE);
    await ctx.runner.exec('root', ['/bin/rm', '-f', tarball]);
    const v = await must(ctx, this.name, 'Checking Node', [node, '--version']);
    if (v.stdout.trim() !== NODE_VERSION) throw new SetupError(this.name, `Node reports ${v.stdout.trim()}, not ${NODE_VERSION}.`);
  },
};

const installRuntime: SetupStep = {
  name: 'Install the sandbox runtime',
  async run(ctx) {
    await must(ctx, this.name, `Making ${INSTALL_DIR}`, ['/usr/bin/install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', INSTALL_DIR]);
    await withResources(ctx, this.name, async () => {
      for (const f of RESOURCE_FILES) {
        await must(ctx, this.name, `Copying ${f.name}`, ['/usr/bin/install', '-o', 'root', '-g', 'root', '-m', f.mode, `${SETUP_MOUNT}/${f.name}`, `${INSTALL_DIR}/${f.name}`]);
      }
    });
    // What the 2026-10-12 probe left behind.
    await ctx.runner.exec('root', ['/bin/rm', '-rf', '/opt/grunt-probe']);
    await must(
      ctx,
      this.name,
      'npm ci',
      ['/usr/bin/env', `PATH=${INSTALL_DIR}/node/bin:/usr/bin:/bin`, `${INSTALL_DIR}/node/bin/npm`, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--prefix', INSTALL_DIR],
      15 * MINUTE
    );
    // Not writable by grunt: a command that broke out as grunt can't change the agent or mount.sh.
    await must(ctx, this.name, `Handing ${INSTALL_DIR} to root`, ['/bin/chown', '-R', 'root:root', INSTALL_DIR]);
    await must(ctx, this.name, `Locking ${INSTALL_DIR}`, ['/bin/chmod', '-R', 'go-w', INSTALL_DIR]);
  },
};

export const SELF_TEST_STEP: SetupStep = {
  name: 'Self-test',
  async run(ctx) {
    try {
      await ctx.selfTest();
    } catch (err) {
      throw new SetupError(this.name, err instanceof Error ? err.message : String(err));
    }
  },
};

/** Every step, in order; each is safe to run again (Repair re-runs them all). */
export const SETUP_STEPS: readonly SetupStep[] = [checkWsl, createDistro, configureDistro, installPackages, installNode, installRuntime, SELF_TEST_STEP];

/** The versions inside a set-up distro, for Settings > Sandbox. */
export async function readVersions(runner: WslRunner): Promise<SandboxVersions> {
  const os = await runner.exec('root', ['/bin/cat', '/etc/os-release']);
  const distro = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(os.stdout)?.[1] ?? 'Ubuntu';
  const node = (await runner.exec('root', [`${INSTALL_DIR}/node/bin/node`, '--version'])).stdout.trim();
  const pkg = await runner.exec('root', ['/bin/cat', `${INSTALL_DIR}/node_modules/@anthropic-ai/sandbox-runtime/package.json`]);
  let runtime = 'unknown';
  try {
    const version = (JSON.parse(pkg.stdout) as { version?: unknown }).version;
    if (typeof version === 'string') runtime = version;
  } catch {
    // keep 'unknown'
  }
  return { distro, node, runtime };
}

/** Settings > Sandbox > Packages > Apply: installs them as root. Throws with apt's message. */
export async function installExtraPackages(runner: WslRunner, packages: string[], log: (line: string) => void): Promise<void> {
  assertPackageNames(packages);
  for (const [label, argv, timeoutMs] of [
    ['apt-get update', apt(['update', '-q']), 15 * MINUTE],
    ['apt-get install', apt(['install', '-y', '-q', ...packages]), 45 * MINUTE],
  ] as const) {
    log(`▶ ${label}`);
    const r = await runner.exec('root', [...argv], { timeoutMs });
    if (r.code !== 0) throw new Error(`${label} failed: ${textOf(r).slice(-1500)}`);
  }
  log(`✔ Installed ${packages.join(', ')}`);
}

export async function runSetup(
  ctx: SetupContext,
  steps: readonly SetupStep[] = SETUP_STEPS
): Promise<{ ok: true; versions: SandboxVersions } | { ok: false; step: string; message: string }> {
  for (const step of steps) {
    ctx.log(`▶ ${step.name}`);
    try {
      await step.run(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`✖ ${step.name}: ${message}`);
      return { ok: false, step: step.name, message };
    }
    ctx.log(`✔ ${step.name}`);
  }
  return { ok: true, versions: await readVersions(ctx.runner) };
}
