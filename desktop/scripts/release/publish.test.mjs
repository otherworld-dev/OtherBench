import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BETA_FEED_TAG, ghReleases, pickRelease, publishRelease } from './github.mjs';

// An in-memory GitHub with the release rules publish depends on: a draft has
// no tag yet and several drafts may share one, `gh` finds a published release
// by its tag before a draft, a second published release with a tag is
// refused, and uploads replace an asset of the same name (`--clobber`).
// `failAt` makes the n-th change throw, as a job that dies there would.
function fakeGitHub({ failAt = 0 } = {}) {
  /** @type {{ tag: string, draft: boolean, prerelease: boolean, title: string, notes: string, target: string, assets: Map<string, string> }[]} */
  const releases = [];
  let latest = /** @type {string | null} */ (null);
  let changes = 0;
  const change = (/** @type {string} */ what) => {
    changes++;
    if (changes === failAt) throw new Error(`gh died during ${what}`);
  };
  const resolve = (/** @type {string} */ tag) => {
    const r = releases.find((x) => x.tag === tag && !x.draft) ?? releases.find((x) => x.tag === tag);
    if (!r) throw new Error(`release not found: ${tag}`);
    return r;
  };
  /** @type {import('./github.mjs').Releases} */
  const api = {
    findRelease(tag) {
      return pickRelease(releases.map((r) => ({ tag: r.tag, draft: r.draft, prerelease: r.prerelease, assets: [...r.assets.keys()] })), tag);
    },
    createRelease(tag, o) {
      change(`create ${tag}`);
      if (releases.some((r) => r.tag === tag && !r.draft) && !o.draft) throw new Error(`a release with tag ${tag} already exists`);
      releases.push({ tag, draft: o.draft, prerelease: o.prerelease, title: o.title, notes: o.notes, target: o.target, assets: new Map() });
      if (!o.draft && o.latest) latest = tag;
    },
    upload(tag, files) {
      change(`upload ${files.map((f) => basename(f)).join(' ')} to ${tag}`);
      const r = resolve(tag);
      for (const f of files) r.assets.set(basename(f), readFileSync(f, 'utf8'));
    },
    editRelease(tag, o) {
      change(`edit ${tag}`);
      const r = resolve(tag);
      if (!o.draft && r.draft && releases.some((x) => x !== r && x.tag === tag && !x.draft)) throw new Error(`a release with tag ${tag} already exists`);
      Object.assign(r, { draft: o.draft, prerelease: o.prerelease, title: o.title, notes: o.notes, target: o.target });
      if (!o.draft && o.latest) latest = tag;
    },
    downloadAsset(tag, name) {
      const text = resolve(tag).assets.get(name);
      if (text === undefined) throw new Error(`no asset ${name} on ${tag}`);
      return text;
    },
  };
  return {
    api,
    /** Everything a user or an installed app could see, in a stable order. */
    state: () => ({
      latest,
      releases: releases
        .map((r) => ({ ...r, assets: Object.fromEntries([...r.assets].sort(([a], [b]) => a.localeCompare(b))) }))
        .sort((a, b) => a.tag.localeCompare(b.tag) || Number(a.draft) - Number(b.draft)),
    }),
  };
}

/** The built files for `version`, as the CI build leaves them; `build` stands in for the bytes (each rebuild differs). */
function built(version, build = 'build-1') {
  const dir = mkdtempSync(join(tmpdir(), 'otherbench-publish-test-'));
  const exe = join(dir, `OtherBench_${version}_x64-setup.exe`);
  writeFileSync(exe, `installer ${version} ${build}`);
  writeFileSync(`${exe}.sig`, `sig ${version} ${build}`);
  const manifest = join(dir, 'latest.json');
  writeFileSync(manifest, JSON.stringify({ version, platforms: { 'windows-x86_64': { signature: `sig ${version} ${build}` } } }));
  const beta = version.includes('-');
  return { tag: `v${version}`, version, beta, target: 'abc123', title: `OtherBench ${version}`, notes: 'fix: a thing', installer: exe, signature: `${exe}.sig`, manifest };
}

const quiet = () => {};
const feedOf = (/** @type {ReturnType<typeof fakeGitHub>} */ gh) => JSON.parse(gh.api.downloadAsset(BETA_FEED_TAG, 'latest.json'));

describe('publishing a release', () => {
  test('a beta is published as a pre-release with its three files, and the beta feed points at it', () => {
    const gh = fakeGitHub();
    publishRelease(gh.api, { ...built('0.2.0-beta.7'), log: quiet });
    const s = gh.state();
    expect(s.latest).toBeNull();
    expect(s.releases.map((r) => [r.tag, r.draft, r.prerelease])).toEqual([
      [BETA_FEED_TAG, false, true],
      ['v0.2.0-beta.7', false, true],
    ]);
    expect(Object.keys(s.releases[1]?.assets ?? {})).toEqual(['latest.json', 'OtherBench_0.2.0-beta.7_x64-setup.exe', 'OtherBench_0.2.0-beta.7_x64-setup.exe.sig']);
    expect(feedOf(gh).version).toBe('0.2.0-beta.7');
  });

  test('a full release is marked latest and leaves the beta feed alone', () => {
    const gh = fakeGitHub();
    publishRelease(gh.api, { ...built('0.2.0'), log: quiet });
    const s = gh.state();
    expect(s.latest).toBe('v0.2.0');
    expect(s.releases.map((r) => [r.tag, r.draft, r.prerelease])).toEqual([['v0.2.0', false, false]]);
  });

  test('running it again for the same version ends where one run does', () => {
    for (const version of ['0.2.0-beta.7', '0.2.0']) {
      const once = fakeGitHub();
      publishRelease(once.api, { ...built(version), log: quiet });
      const twice = fakeGitHub();
      const files = built(version);
      publishRelease(twice.api, { ...files, log: quiet });
      publishRelease(twice.api, { ...files, log: quiet });
      expect(twice.state()).toEqual(once.state());
    }
  });

  test('a run that died at any step is finished by the next one', () => {
    for (const version of ['0.2.0-beta.7', '0.2.0']) {
      const clean = fakeGitHub();
      const files = built(version);
      publishRelease(clean.api, { ...files, log: quiet });
      for (let failAt = 1; ; failAt++) {
        const gh = fakeGitHub({ failAt });
        let died = false;
        try {
          publishRelease(gh.api, { ...files, log: quiet });
        } catch {
          died = true;
        }
        if (!died) break; // past the last change: every step has had its turn to fail
        publishRelease(gh.api, { ...files, log: quiet });
        expect(gh.state(), `${version}, died at change ${failAt}`).toEqual(clean.state());
      }
    }
  });

  test('a re-run that rebuilt the installer replaces its files and the beta feed, so the signature matches what is downloaded', () => {
    const gh = fakeGitHub();
    publishRelease(gh.api, { ...built('0.2.0-beta.7', 'build-1'), log: quiet });
    publishRelease(gh.api, { ...built('0.2.0-beta.7', 'build-2'), log: quiet });
    const release = gh.state().releases.find((r) => r.tag === 'v0.2.0-beta.7');
    expect(release?.assets['OtherBench_0.2.0-beta.7_x64-setup.exe']).toBe('installer 0.2.0-beta.7 build-2');
    expect(release?.assets['OtherBench_0.2.0-beta.7_x64-setup.exe.sig']).toBe('sig 0.2.0-beta.7 build-2');
    expect(JSON.parse(release?.assets['latest.json'] ?? '{}').platforms['windows-x86_64'].signature).toBe('sig 0.2.0-beta.7 build-2');
    expect(feedOf(gh).platforms['windows-x86_64'].signature).toBe('sig 0.2.0-beta.7 build-2');
  });

  test('a re-run of an older beta never moves the feed back', () => {
    const gh = fakeGitHub();
    publishRelease(gh.api, { ...built('0.2.0-beta.7'), log: quiet });
    publishRelease(gh.api, { ...built('0.2.0-beta.8'), log: quiet });
    publishRelease(gh.api, { ...built('0.2.0-beta.7', 'build-2'), log: quiet });
    expect(feedOf(gh).version).toBe('0.2.0-beta.8');
  });

  test("a beta feed that can't be read stops the run instead of being overwritten", () => {
    const gh = fakeGitHub();
    publishRelease(gh.api, { ...built('0.2.0-beta.8'), log: quiet });
    const broken = { ...gh.api, downloadAsset: () => { throw new Error('HTTP 502'); } };
    expect(() => publishRelease(broken, { ...built('0.2.0-beta.7'), log: quiet })).toThrow(/502/);
    expect(feedOf(gh).version).toBe('0.2.0-beta.8');
  });

  test('a draft left by a run that died is reused, not duplicated', () => {
    const gh = fakeGitHub({ failAt: 2 }); // dies uploading, after creating the draft
    const files = built('0.2.0-beta.7');
    expect(() => publishRelease(gh.api, { ...files, log: quiet })).toThrow();
    expect(gh.state().releases.map((r) => [r.tag, r.draft])).toEqual([['v0.2.0-beta.7', true]]);
    publishRelease(gh.api, { ...files, log: quiet });
    expect(gh.state().releases.filter((r) => r.tag === 'v0.2.0-beta.7').map((r) => r.draft)).toEqual([false]);
  });
});

describe('pickRelease', () => {
  test('takes the published release for a tag over a draft, and a draft when that is all there is', () => {
    const draft = { tag: 'v1.0.0', draft: true, prerelease: false, assets: [] };
    const published = { tag: 'v1.0.0', draft: false, prerelease: false, assets: ['latest.json'] };
    expect(pickRelease([draft, published], 'v1.0.0')).toBe(published);
    expect(pickRelease([draft], 'v1.0.0')).toBe(draft);
    expect(pickRelease([draft, published], 'v2.0.0')).toBeNull();
  });
});

describe('ghReleases: the gh calls', () => {
  /** @param {(args: string[]) => string} [answer] */
  function recorder(answer = () => '') {
    /** @type {string[][]} */
    const calls = [];
    return { calls, gh: (/** @type {string[]} */ args) => (calls.push(args), answer(args)) };
  }

  test('finds a release among every page of the list, drafts included', () => {
    const lines = [
      JSON.stringify({ tag: 'v0.2.0-beta.7', draft: true, prerelease: true, assets: [] }),
      JSON.stringify({ tag: 'v0.2.0-beta.7', draft: false, prerelease: true, assets: ['latest.json'] }),
    ].join('\n');
    const { calls, gh } = recorder(() => `${lines}\n`);
    expect(ghReleases(gh, 'o/r').findRelease('v0.2.0-beta.7')).toEqual({ tag: 'v0.2.0-beta.7', draft: false, prerelease: true, assets: ['latest.json'] });
    expect(calls[0]?.slice(0, 3)).toEqual(['api', 'repos/o/r/releases?per_page=100', '--paginate']);
    expect(calls[0]?.at(-1)).toContain('select(.tag_name == "v0.2.0-beta.7")');
    expect(ghReleases(recorder(() => '').gh, 'o/r').findRelease('v9.9.9')).toBeNull();
  });

  test('creates a draft, and publishes it with the channel flags', () => {
    const { calls, gh } = recorder();
    const releases = ghReleases(gh, 'o/r');
    releases.createRelease('v0.2.0', { target: 'abc', title: 'T', notes: 'N', draft: true, prerelease: false, latest: false });
    releases.editRelease('v0.2.0', { target: 'abc', title: 'T', notes: 'N', draft: false, prerelease: false, latest: true });
    releases.editRelease('v0.2.0-beta.1', { target: 'abc', title: 'T', notes: 'N', draft: false, prerelease: true, latest: false });
    expect(calls).toEqual([
      ['release', 'create', 'v0.2.0', '-R', 'o/r', '--target', 'abc', '--title', 'T', '--notes', 'N', '--draft', '--prerelease=false', '--latest=false'],
      ['release', 'edit', 'v0.2.0', '-R', 'o/r', '--target', 'abc', '--title', 'T', '--notes', 'N', '--draft=false', '--prerelease=false', '--latest'],
      ['release', 'edit', 'v0.2.0-beta.1', '-R', 'o/r', '--target', 'abc', '--title', 'T', '--notes', 'N', '--draft=false', '--prerelease', '--latest=false'],
    ]);
  });

  test('uploads replace files of the same name, and a download reads the file gh wrote', () => {
    const { calls, gh } = recorder((args) => {
      if (args[1] === 'download') writeFileSync(join(/** @type {string} */ (args[args.indexOf('-D') + 1]), 'latest.json'), '{"version":"1.0.0"}');
      return '';
    });
    const releases = ghReleases(gh, 'o/r');
    releases.upload('v1.0.0', ['a.exe', 'a.exe.sig']);
    expect(calls[0]).toEqual(['release', 'upload', 'v1.0.0', 'a.exe', 'a.exe.sig', '-R', 'o/r', '--clobber']);
    expect(releases.downloadAsset('beta-channel', 'latest.json')).toBe('{"version":"1.0.0"}');
    expect(calls[1]?.slice(0, 6)).toEqual(['release', 'download', 'beta-channel', '-R', 'o/r', '-p']);
  });
});
