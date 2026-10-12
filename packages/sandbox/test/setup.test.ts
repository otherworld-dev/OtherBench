import { describe, expect, it, vi } from 'vitest';
import type { WslResult } from '../src/wsl.js';
import { BASE_PACKAGES, distroNames, installExtraPackages, NODE_URL, parseWslVersion, runSetup } from '../src/setup.js';
import { FakeWsl, happyWsl, type WslCall } from './helpers.js';

const RESOURCES = 'E:\\Grunt\\packages\\sandbox\\resources';

async function setUp(wsl: FakeWsl, opts: { packages?: string[]; selfTest?: () => Promise<void> } = {}) {
  const log: string[] = [];
  const selfTest = vi.fn(opts.selfTest ?? (async () => {}));
  const outcome = await runSetup({ runner: wsl, resourcesDir: RESOURCES, packages: opts.packages ?? [], log: (line) => log.push(line), selfTest });
  return { outcome, log, selfTest };
}
const failing = (override: (call: WslCall) => Partial<WslResult> | undefined, selfTest?: () => Promise<void>) =>
  setUp(happyWsl({ override }), selfTest ? { selfTest } : {});
const isProgram = (call: WslCall, program: string, ...args: string[]): boolean =>
  call.kind === 'exec' && call.argv[0] === program && args.every((a) => call.argv.includes(a));

describe('runSetup', () => {
  it('sets up a fresh machine: creates the distro, configures it, installs everything, self-tests and reads the versions', async () => {
    const wsl = happyWsl();
    const { outcome, log, selfTest } = await setUp(wsl, { packages: ['ffmpeg'] });
    expect(outcome).toEqual({ ok: true, versions: { distro: 'Ubuntu 24.04.5 LTS', node: 'v24.21.0', runtime: '0.0.79' } });
    const c = wsl.commands;
    const at = (line: string): number => {
      const i = c.indexOf(line);
      expect(i, line).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at('wsl --version')).toBeLessThan(at('wsl --install Ubuntu-24.04 --name grunt-sandbox --no-launch'));
    expect(at(`root: /bin/mount -t drvfs ${RESOURCES} /mnt/grunt-setup -o ro`)).toBeLessThan(at('root: /usr/bin/install -o root -g root -m 0644 /mnt/grunt-setup/wsl.conf /etc/wsl.conf'));
    expect(at('root: /usr/bin/install -o root -g root -m 0644 /mnt/grunt-setup/wsl.conf /etc/wsl.conf')).toBeLessThan(at('wsl --terminate grunt-sandbox'));
    at(`root: /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y -q ${[...BASE_PACKAGES, 'ffmpeg'].join(' ')}`);
    at('root: /usr/sbin/useradd -m -s /bin/bash grunt');
    at('root: /usr/bin/install -d -o grunt -g grunt -m 0700 /home/grunt/chats');
    at(`root: /usr/bin/curl -fsSL --retry 3 -o /tmp/grunt-node.tar.xz ${NODE_URL}`);
    expect(at('root: /usr/bin/sha256sum /tmp/grunt-node.tar.xz')).toBeLessThan(at('root: /bin/tar -xJf /tmp/grunt-node.tar.xz -C /opt/grunt-sandbox/node --strip-components=1'));
    at('root: /usr/bin/install -o root -g root -m 0644 /mnt/grunt-setup/agent.mjs /opt/grunt-sandbox/agent.mjs');
    at('root: /usr/bin/install -o root -g root -m 0644 /mnt/grunt-setup/agent-core.mjs /opt/grunt-sandbox/agent-core.mjs');
    at('root: /usr/bin/install -o root -g root -m 0644 /mnt/grunt-setup/package-lock.json /opt/grunt-sandbox/package-lock.json');
    at('root: /usr/bin/install -o root -g root -m 0755 /mnt/grunt-setup/mount.sh /opt/grunt-sandbox/mount.sh');
    at('root: /bin/rm -rf /opt/grunt-probe');
    expect(at('root: /usr/bin/env PATH=/opt/grunt-sandbox/node/bin:/usr/bin:/bin /opt/grunt-sandbox/node/bin/npm ci --omit=dev --no-audit --no-fund --prefix /opt/grunt-sandbox')).toBeLessThan(
      at('root: /bin/chown -R root:root /opt/grunt-sandbox')
    );
    at('root: /bin/chmod -R go-w /opt/grunt-sandbox');
    // Each of the two steps that copy files clears a leftover mount first and unmounts after.
    expect(c.filter((line) => line === 'root: /bin/umount /mnt/grunt-setup')).toHaveLength(4);
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(log).toEqual(expect.arrayContaining(['▶ Check WSL', '✔ Check WSL', '▶ Self-test', '✔ Self-test']));
    // Nothing is ever run through a Linux shell.
    expect(wsl.calls.every((call) => call.kind === 'wsl' || !call.argv.includes('--'))).toBe(true);
  });

  it('repairs an existing distro: no new distro, no new user, no Node download when the pinned one is there', async () => {
    const wsl = happyWsl({ distros: 'Ubuntu\r\ngrunt-sandbox\r\n', user: true, node: true });
    const { outcome, log } = await setUp(wsl);
    expect(outcome.ok).toBe(true);
    expect(wsl.commands.some((l) => l.startsWith('wsl --install'))).toBe(false);
    expect(wsl.commands.some((l) => l.includes('useradd'))).toBe(false);
    expect(wsl.commands.some((l) => l.includes('/usr/bin/curl'))).toBe(false);
    expect(log).toContain('grunt-sandbox already exists: repairing it.');
    expect(log).toContain('Node v24.21.0 is already installed.');
  });

  it('stops at "Check WSL" with how to install it when WSL is missing', async () => {
    const wsl = happyWsl({ override: (c) => (c.kind === 'wsl' && c.args[0] === '--version' ? { code: 1, stderr: 'not found' } : undefined) });
    const { outcome } = await setUp(wsl);
    expect(outcome).toMatchObject({ ok: false, step: 'Check WSL', message: expect.stringContaining('wsl --install') });
    expect(wsl.calls).toHaveLength(1);
  });

  it('says WSL is too old below 2.4', async () => {
    const { outcome } = await failing((c) => (c.kind === 'wsl' && c.args[0] === '--version' ? { stdout: 'WSL version: 2.3.26.0\r\n' } : undefined));
    expect(outcome).toMatchObject({ ok: false, step: 'Check WSL', message: expect.stringContaining('2.3.26 is too old') });
  });

  it('stops when Windows interop is still on after the restart', async () => {
    const { outcome } = await failing((c) => (isProgram(c, '/usr/bin/test') ? { code: 0 } : undefined));
    expect(outcome).toMatchObject({ ok: false, step: 'Configure the distro', message: expect.stringContaining('interop') });
  });

  it("stops at \"Install packages\" with the end of apt's output", async () => {
    const { outcome } = await failing((c) => (isProgram(c, '/usr/bin/env', 'install') ? { code: 100, stderr: 'E: Unable to locate package ffmpegg' } : undefined));
    expect(outcome).toMatchObject({ ok: false, step: 'Install packages', message: expect.stringContaining('Unable to locate package ffmpegg') });
  });

  it("refuses a Node download that doesn't match its checksum, and deletes it", async () => {
    const wsl = happyWsl({ override: (c) => (isProgram(c, '/usr/bin/sha256sum') ? { stdout: 'deadbeef  /tmp/grunt-node.tar.xz\n' } : undefined) });
    const { outcome } = await setUp(wsl);
    expect(outcome).toMatchObject({ ok: false, step: 'Install Node', message: expect.stringContaining('SHA-256') });
    expect(wsl.commands).toContain('root: /bin/rm -f /tmp/grunt-node.tar.xz');
    expect(wsl.commands.some((l) => l.startsWith('root: /bin/tar'))).toBe(false);
  });

  it('marks setup failed when the self-test finds a surprise, and logs each step up to it', async () => {
    const { outcome, log } = await failing(() => undefined, async () => {
      throw new Error('Self-test "cmd.exe isn\'t there" was not blocked (exit 0)');
    });
    expect(outcome).toMatchObject({ ok: false, step: 'Self-test', message: expect.stringContaining('was not blocked') });
    expect(log.at(-1)).toMatch(/^✖ Self-test: /);
    expect(log).toContain('✔ Install the sandbox runtime');
  });

  it('stops at the first failing step and runs nothing after it', async () => {
    const wsl = happyWsl({ override: (c) => (isProgram(c, '/usr/bin/curl') ? { code: 6, stderr: 'curl: (6) Could not resolve host: nodejs.org' } : undefined) });
    const { outcome, log } = await setUp(wsl);
    expect(outcome).toMatchObject({ ok: false, step: 'Install Node', message: expect.stringContaining('Could not resolve host') });
    expect(log).not.toContain('▶ Install the sandbox runtime');
    expect(wsl.commands.some((l) => l.includes('npm ci'))).toBe(false);
  });
});

describe('setup helpers', () => {
  it('reads the WSL version from the first version number', () => {
    expect(parseWslVersion('WSL version: 2.7.3.0\r\nKernel version: 6.6.87.2-1')).toEqual([2, 7, 3]);
    expect(parseWslVersion('WSL-Version: 2.4.0.0')).toEqual([2, 4, 0]);
    expect(parseWslVersion('Usage: wsl.exe [Argument]')).toBeNull();
  });

  it('lists distro names, dropping blank lines and stray NULs', () => {
    expect(distroNames('Ubuntu\r\n\0grunt-sandbox\r\n\r\n')).toEqual(['Ubuntu', 'grunt-sandbox']);
  });

  it("installs extra packages as root, and fails with apt's message", async () => {
    const wsl = new FakeWsl();
    await installExtraPackages(wsl, ['ffmpeg', 'pandoc'], () => {});
    expect(wsl.commands).toEqual([
      'root: /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get update -q',
      'root: /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y -q ffmpeg pandoc',
    ]);
    const broken = new FakeWsl((c) => (c.kind === 'exec' && c.argv.includes('install') ? { code: 100, stderr: 'E: Unable to locate package pandocc' } : undefined));
    await expect(installExtraPackages(broken, ['pandocc'], () => {})).rejects.toThrow(/Unable to locate package pandocc/);
  });

  it('never hands apt, which runs as root, a name that could be an option', async () => {
    const wsl = new FakeWsl();
    await expect(installExtraPackages(wsl, ['ffmpeg', '-oAPT::Update::Pre-Invoke::=id'], () => {})).rejects.toThrow(/not an apt package name/);
    expect(wsl.calls).toHaveLength(0);
    const setup = happyWsl();
    const { outcome } = await setUp(setup, { packages: ['--reinstall'] });
    expect(outcome).toMatchObject({ ok: false, step: 'Install packages', message: expect.stringContaining('not an apt package name') });
    expect(setup.commands.some((l) => l.includes('apt-get'))).toBe(false);
  });
});
