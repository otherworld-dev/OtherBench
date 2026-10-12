import { describe, expect, it, vi } from 'vitest';
import type { WslResult } from '../src/wsl.js';
import { BASE_PACKAGES, distroNames, installExtraPackages, NODE_URL, parseWslVersion, runSetup } from '../src/setup.js';
import { FakeWsl, happyWsl, STAGING, type WslCall } from './helpers.js';

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
    // Created by the grunt user, so a link grunt planted at `chats` is never followed by a root chown.
    at('grunt: /bin/mkdir -p -m 0700 /home/grunt/chats');
    expect(c.filter((line) => line.startsWith('root:') && line.includes('/home/grunt'))).toEqual([]);
    // Everything root downloads, unpacks and installs happens in a private build folder under /opt, never in /tmp or in the old install.
    const tree = `${STAGING}/tree`;
    const mktemp = at('root: /usr/bin/mktemp -d /opt/.grunt-sandbox.XXXXXX');
    expect(at('root: /usr/bin/find /opt -mindepth 1 -maxdepth 1 -name .grunt-sandbox.* -exec /bin/rm -rf {} +')).toBeLessThan(mktemp);
    const curl = at(`root: /usr/bin/curl -fsSL --proto =https --tlsv1.2 --retry 3 -o ${STAGING}/node.tar.xz ${NODE_URL}`);
    expect(mktemp).toBeLessThan(curl);
    const sha = at(`root: /usr/bin/sha256sum ${STAGING}/node.tar.xz`);
    const tar = at(`root: /bin/tar --no-same-owner -xJf ${STAGING}/node.tar.xz -C ${tree}/node --strip-components=1`);
    expect(curl).toBeLessThan(sha);
    expect(sha).toBeLessThan(tar);
    const copy = at(`root: /usr/bin/install -o root -g root -m 0644 /mnt/grunt-setup/agent.mjs ${tree}/agent.mjs`);
    at(`root: /usr/bin/install -o root -g root -m 0644 /mnt/grunt-setup/agent-core.mjs ${tree}/agent-core.mjs`);
    at(`root: /usr/bin/install -o root -g root -m 0644 /mnt/grunt-setup/package-lock.json ${tree}/package-lock.json`);
    at(`root: /usr/bin/install -o root -g root -m 0755 /mnt/grunt-setup/mount.sh ${tree}/mount.sh`);
    at('root: /bin/rm -rf /opt/grunt-probe');
    const npm = at(
      `root: /usr/bin/env PATH=${tree}/node/bin:/usr/bin:/bin HOME=${STAGING} ${tree}/node/bin/npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache ${STAGING}/npm-cache --prefix ${tree}`
    );
    expect(tar).toBeLessThan(copy);
    expect(copy).toBeLessThan(npm);
    // Locked, swapped in whole (the old install is never reused), checked, and the build folder removed last.
    const lock = at(`root: /bin/chmod -R go-w,a+rX ${tree}`);
    // The tree is checked before it is swapped in, and again where it ends up.
    const before = c.findIndex((line) => line.startsWith(`root: /usr/bin/find ${tree} `));
    const swap = [at('root: /usr/bin/test -e /opt/grunt-sandbox'), at(`root: /bin/mv -T ${tree} /opt/grunt-sandbox`), at('root: /bin/chmod 0755 /opt/grunt-sandbox')];
    const verify = c.findIndex((line) => line.startsWith('root: /usr/bin/find /opt/grunt-sandbox '));
    const cleanup = c.lastIndexOf(`root: /bin/rm -rf ${STAGING}`);
    const order = [npm, lock, before, ...swap, verify, cleanup];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
    expect(before).toBeGreaterThan(0);
    expect(verify).toBeGreaterThan(0);
    // Nothing there to set aside on a fresh machine, and nothing deleted outside the build folder.
    expect(c.some((line) => line.startsWith('root: /bin/mv -T /opt/grunt-sandbox '))).toBe(false);
    expect(c.some((line) => line === 'root: /bin/rm -rf /opt/grunt-sandbox')).toBe(false);
    expect(c.some((line) => line.includes('chown'))).toBe(false);
    expect(c.some((line) => line.includes('/tmp/grunt'))).toBe(false);
    // The resource folder is mounted before it is read and unmounted after, by each of the two steps that copy from it.
    const mounts = c.flatMap((line, i) => (line === `root: /bin/mount -t drvfs ${RESOURCES} /mnt/grunt-setup -o ro` ? [i] : []));
    const unmounts = c.flatMap((line, i) => (line === 'root: /bin/umount /mnt/grunt-setup' ? [i] : []));
    expect(mounts).toHaveLength(2);
    for (const m of mounts) expect(unmounts.some((u) => u > m)).toBe(true);
    expect(unmounts.filter((u) => u < mounts[0]!).length).toBeGreaterThan(0);
    expect(unmounts.at(-1)).toBeGreaterThan(mounts[1]!);
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(log).toEqual(expect.arrayContaining(['▶ Check WSL', '✔ Check WSL', '▶ Self-test', '✔ Self-test']));
    // Nothing is ever run through a Linux shell.
    expect(wsl.calls.every((call) => call.kind === 'wsl' || !call.argv.includes('--'))).toBe(true);
  });

  it('repairs an existing distro: no new distro, no new user, and the install is rebuilt rather than reused', async () => {
    const wsl = happyWsl({
      distros: 'Ubuntu\r\ngrunt-sandbox\r\n',
      user: true,
      node: true,
      override: (c) => (isProgram(c, '/usr/bin/test', '/opt/grunt-sandbox') ? { code: 0 } : undefined),
    });
    const { outcome, log } = await setUp(wsl);
    expect(outcome.ok).toBe(true);
    expect(wsl.commands.some((l) => l.startsWith('wsl --install'))).toBe(false);
    expect(wsl.commands.some((l) => l.includes('useradd'))).toBe(false);
    // An existing /opt/grunt-sandbox may have been written by the grunt user: it is replaced, never trusted.
    expect(wsl.commands.some((l) => l.includes('/usr/bin/curl'))).toBe(true);
    // ... set aside inside the build folder (removed with it), not deleted up front.
    const aside = wsl.commands.indexOf(`root: /bin/mv -T /opt/grunt-sandbox ${STAGING}/old`);
    expect(aside).toBeGreaterThan(0);
    expect(aside).toBeLessThan(wsl.commands.indexOf(`root: /bin/mv -T ${STAGING}/tree /opt/grunt-sandbox`));
    expect(wsl.commands).not.toContain('root: /bin/rm -rf /opt/grunt-sandbox');
    expect(log).toContain('grunt-sandbox already exists: repairing it.');
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

  it('stops when the late interop entry is on, or when the check itself did not give a clear "not there"', async () => {
    const late = await failing((c) => (isProgram(c, '/usr/bin/test') && c.kind === 'exec' && c.argv.includes('/proc/sys/fs/binfmt_misc/WSLInterop-late') ? { code: 0 } : undefined));
    expect(late).toMatchObject({ outcome: { ok: false, step: 'Configure the distro', message: expect.stringContaining('interop') } });
    for (const odd of [{ code: 2 }, { code: null, timedOut: true }, { code: 127 }]) {
      const { outcome } = await failing((c) => (isProgram(c, '/usr/bin/test') ? odd : undefined));
      expect(outcome).toMatchObject({ ok: false, step: 'Configure the distro', message: expect.stringContaining("Couldn't confirm") });
    }
  });

  it("stops at \"Install packages\" with the end of apt's output", async () => {
    const { outcome } = await failing((c) => (isProgram(c, '/usr/bin/env', 'install') ? { code: 100, stderr: 'E: Unable to locate package ffmpegg' } : undefined));
    expect(outcome).toMatchObject({ ok: false, step: 'Install packages', message: expect.stringContaining('Unable to locate package ffmpegg') });
  });

  it("refuses a Node download that doesn't match its checksum, and removes the build folder", async () => {
    const wsl = happyWsl({ override: (c) => (isProgram(c, '/usr/bin/sha256sum') ? { stdout: `deadbeef  ${STAGING}/node.tar.xz\n` } : undefined) });
    const { outcome } = await setUp(wsl);
    expect(outcome).toMatchObject({ ok: false, step: 'Install Node', message: expect.stringContaining('SHA-256') });
    expect(wsl.commands.at(-1)).toBe(`root: /bin/rm -rf ${STAGING}`);
    expect(wsl.commands.some((l) => l.startsWith('root: /bin/tar'))).toBe(false);
  });

  it('removes the build folder when a later step fails, and when the self-test does', async () => {
    const unpack = happyWsl({ override: (c) => (isProgram(c, '/bin/tar') ? { code: 2, stderr: 'tar: Unexpected EOF' } : undefined) });
    expect((await setUp(unpack)).outcome).toMatchObject({ ok: false, step: 'Install Node' });
    expect(unpack.commands.at(-1)).toBe(`root: /bin/rm -rf ${STAGING}`);
    const npm = happyWsl({ override: (c) => (isProgram(c, '/usr/bin/env', 'ci') ? { code: 1, stderr: 'npm ERR! network' } : undefined) });
    expect((await setUp(npm)).outcome).toMatchObject({ ok: false, step: 'Install the sandbox runtime', message: expect.stringContaining('npm ci failed') });
    expect(npm.commands.at(-1)).toBe(`root: /bin/rm -rf ${STAGING}`);
    // Nothing was swapped into place.
    expect(npm.commands).not.toContain('root: /bin/rm -rf /opt/grunt-sandbox');
    const selfTest = happyWsl();
    await setUp(selfTest, { selfTest: async () => { throw new Error('surprise'); } });
    expect(selfTest.commands.at(-1)).toBe(`root: /bin/rm -rf ${STAGING}`);
  });

  it('does not delete a build folder that is not where mktemp should have put it', async () => {
    const wsl = happyWsl({ override: (c) => (isProgram(c, '/usr/bin/mktemp') ? { stdout: '/etc\n' } : undefined) });
    const { outcome } = await setUp(wsl);
    expect(outcome).toMatchObject({ ok: false, step: 'Install Node', message: expect.stringContaining('unexpected folder') });
    expect(wsl.commands.some((l) => l.includes('rm -rf /etc'))).toBe(false);
  });

  it('never swaps in a tree whose ownership check fails', async () => {
    const wsl = happyWsl({
      distros: 'Ubuntu\r\ngrunt-sandbox\r\n',
      override: (c) => (c.kind === 'exec' && c.argv[0] === '/usr/bin/find' && c.argv[1] === `${STAGING}/tree` ? { stdout: `${STAGING}/tree/node_modules/evil\n` } : undefined),
    });
    const { outcome } = await setUp(wsl);
    expect(outcome).toMatchObject({ ok: false, step: 'Install the sandbox runtime', message: expect.stringContaining('evil') });
    expect(wsl.commands.some((l) => l.startsWith('root: /bin/mv'))).toBe(false);
  });

  it('puts the old install back when the new one cannot be moved in', async () => {
    const wsl = happyWsl({
      override: (c) => {
        if (isProgram(c, '/usr/bin/test', '/opt/grunt-sandbox')) return { code: 0 };
        if (isProgram(c, '/bin/mv', `${STAGING}/tree`)) return { code: 1, stderr: 'mv: cannot move' };
        return undefined;
      },
    });
    const { outcome } = await setUp(wsl);
    expect(outcome).toMatchObject({ ok: false, step: 'Install the sandbox runtime', message: expect.stringContaining('cannot move') });
    const c = wsl.commands;
    const aside = c.indexOf(`root: /bin/mv -T /opt/grunt-sandbox ${STAGING}/old`);
    const back = c.indexOf(`root: /bin/mv -T ${STAGING}/old /opt/grunt-sandbox`);
    expect(aside).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(aside);
    expect(c.at(-1)).toBe(`root: /bin/rm -rf ${STAGING}`);
  });

  it('fails the install when something in it is not root-owned or is writable by others, naming the first few', async () => {
    const found = Array.from({ length: 8 }, (_, i) => `/opt/grunt-sandbox/node_modules/x${i}`).join('\n');
    const wsl = happyWsl({ override: (c) => (c.kind === 'exec' && c.argv[0] === '/usr/bin/find' && c.argv[1] === '/opt/grunt-sandbox' ? { stdout: `${found}\n` } : undefined) });
    const { outcome } = await setUp(wsl);
    expect(outcome).toMatchObject({ ok: false, step: 'Install the sandbox runtime', message: expect.stringContaining('8 item(s)') });
    expect(outcome).toMatchObject({ message: expect.stringContaining('x4') });
    expect((outcome as { message: string }).message).not.toContain('x5');
    expect(wsl.commands.at(-1)).toBe(`root: /bin/rm -rf ${STAGING}`);
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
    for (const name of ['ffmpeg-', 'foo.deb', '../x', 'A']) {
      await expect(installExtraPackages(new FakeWsl(), [name], () => {})).rejects.toThrow(/not an apt package name/);
    }
    const none = new FakeWsl();
    const log: string[] = [];
    await installExtraPackages(none, [], (l) => log.push(l));
    expect(none.calls).toHaveLength(0);
    expect(log).toEqual([]);
    const setup = happyWsl();
    const { outcome } = await setUp(setup, { packages: ['--reinstall'] });
    expect(outcome).toMatchObject({ ok: false, step: 'Install packages', message: expect.stringContaining('not an apt package name') });
    expect(setup.commands.some((l) => l.includes('apt-get'))).toBe(false);
  });
});
