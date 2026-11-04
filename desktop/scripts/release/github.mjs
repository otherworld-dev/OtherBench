// Publishing a built release to GitHub, so that running it again for the same
// version (CI's release job is re-run when a flaky test held it up, or after
// it died half way) ends where one clean run does: it reuses the release a
// run before it made, published or still a draft, replaces its files, and
// puts the beta feed on the new build's signature.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shouldReplaceFeed } from './manifest.mjs';
import { parseSemver } from './semver.mjs';

/** The fixed pre-release whose `latest.json` is the beta feed. */
export const BETA_FEED_TAG = 'beta-channel';

/**
 * @typedef {{ tag: string, draft: boolean, prerelease: boolean, assets: string[] }} ReleaseInfo
 * @typedef {{ target: string, title: string, notes: string, draft: boolean, prerelease: boolean, latest: boolean }} ReleaseFields
 * @typedef {{
 *   findRelease(tag: string): ReleaseInfo | null,
 *   createRelease(tag: string, fields: ReleaseFields): void,
 *   upload(tag: string, files: string[]): void,
 *   editRelease(tag: string, fields: ReleaseFields): void,
 *   downloadAsset(tag: string, name: string): string,
 * }} Releases
 */

/**
 * The release for `tag`: the published one, else a draft (a run that died
 * after creating it), else null. `gh` resolves a tag the same way.
 * @param {ReleaseInfo[]} releases @param {string} tag
 */
export function pickRelease(releases, tag) {
  const withTag = releases.filter((r) => r.tag === tag);
  return withTag.find((r) => !r.draft) ?? withTag[0] ?? null;
}

/**
 * `Releases` over the `gh` CLI. Every upload replaces a file of the same name.
 * @param {(args: string[]) => string} gh runs `gh` with these arguments and returns its stdout
 * @param {string} repo owner/name
 * @returns {Releases}
 */
export function ghReleases(gh, repo) {
  /** @param {ReleaseFields} f */
  const flags = (f) => [
    '--target', f.target, '--title', f.title, '--notes', f.notes,
    f.draft ? '--draft' : '--draft=false',
    f.prerelease ? '--prerelease' : '--prerelease=false',
    f.latest ? '--latest' : '--latest=false',
  ];
  return {
    findRelease(tag) {
      // The whole list, not `releases/tags/<tag>`, which never shows a draft.
      const out = gh([
        'api', `repos/${repo}/releases?per_page=100`, '--paginate',
        '--jq', `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {tag: .tag_name, draft, prerelease, assets: [.assets[].name]} | @json`,
      ]);
      const found = out.split('\n').filter((l) => l.trim()).map((l) => /** @type {ReleaseInfo} */ (JSON.parse(l)));
      return pickRelease(found, tag);
    },
    createRelease(tag, f) {
      gh(['release', 'create', tag, '-R', repo, ...flags(f)]);
    },
    upload(tag, files) {
      gh(['release', 'upload', tag, ...files, '-R', repo, '--clobber']);
    },
    editRelease(tag, f) {
      gh(['release', 'edit', tag, '-R', repo, ...flags(f)]);
    },
    downloadAsset(tag, name) {
      const dir = mkdtempSync(join(tmpdir(), 'otherbench-asset-'));
      gh(['release', 'download', tag, '-R', repo, '-p', name, '-D', dir, '--clobber']);
      return readFileSync(join(dir, name), 'utf8');
    },
  };
}

/**
 * Publishes a built installer, its signature and its `latest.json` as release
 * `tag`. A new release is made as a draft and published once its files are
 * all there, so no one sees it half uploaded; one that exists already (from
 * an earlier run of the same version) has its files replaced. A beta then
 * becomes the beta feed unless that holds a higher version. A re-run of the
 * same version replaces the feed too: its build was signed afresh, and the
 * feed must carry the signature of the installer now at that URL.
 *
 * @param {Releases} releases
 * @param {{ tag: string, version: string, beta: boolean, target: string, title: string, notes: string,
 *           installer: string, signature: string, manifest: string, log: (line: string) => void }} input
 */
export function publishRelease(releases, { tag, version, beta, target, title, notes, installer, signature, manifest, log }) {
  const existing = releases.findRelease(tag);
  if (existing) log(`${tag} exists${existing.draft ? ' as a draft' : ''}: replacing its files`);
  else releases.createRelease(tag, { target, title, notes, draft: true, prerelease: beta, latest: false });
  releases.upload(tag, [installer, signature]);
  // The manifest last: it names the signature of the installer now uploaded.
  releases.upload(tag, [manifest]);
  releases.editRelease(tag, { target, title, notes, draft: false, prerelease: beta, latest: !beta });
  log(`published ${tag}`);
  if (!beta) return;

  let feed = releases.findRelease(BETA_FEED_TAG);
  if (!feed) {
    releases.createRelease(BETA_FEED_TAG, {
      target, draft: false, prerelease: true, latest: false, title: 'Beta channel',
      notes: 'Holds the beta updater feed (latest.json). Not a release: install a vX.Y.Z-beta.N release instead.',
    });
    feed = { tag: BETA_FEED_TAG, draft: false, prerelease: true, assets: [] };
  }
  // A feed that's there but can't be read stops the run: guessing "none" could put machines back on an older build.
  const current = feed.assets.includes('latest.json') ? feedVersion(releases.downloadAsset(BETA_FEED_TAG, 'latest.json')) : null;
  if (!shouldReplaceFeed(current, version)) {
    log(`beta feed stays on ${current}, which is newer than ${version}`);
    return;
  }
  releases.upload(BETA_FEED_TAG, [manifest]);
  log(`beta feed now ${version}${current ? ` (was ${current}${current === version ? ', an earlier build of it' : ''})` : ''}`);
}

/** @param {string} text a `latest.json` */
function feedVersion(text) {
  const v = JSON.parse(text).version;
  return typeof v === 'string' && parseSemver(v) ? v : null;
}
