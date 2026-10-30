// CI's release steps (.github/workflows/ci.yml, job `release`):
//
//   node desktop/scripts/release/publish.mjs version   picks this build's version and writes it into desktop/package.json
//   node desktop/scripts/release/publish.mjs publish   publishes the built installer as a GitHub release, with its updater manifest
//
// Reads GITHUB_REF, GITHUB_RUN_NUMBER and GITHUB_SHA, and uses `gh` (GH_TOKEN).
// Full releases (`vX.Y.Z` tags) are marked latest, which is the feed full-channel
// machines read. Betas are pre-releases; the beta feed is the `latest.json` of
// the fixed pre-release `beta-channel`, only ever replaced by a higher version.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldReplaceFeed, updaterManifest } from './manifest.mjs';
import { parseSemver } from './semver.mjs';
import { releaseVersion } from './version.mjs';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJson = join(desktopDir, 'package.json');
const nsisDir = join(desktopDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const repo = process.env.GITHUB_REPOSITORY || 'otherworld-dev/OtherBench';
const BETA_FEED_TAG = 'beta-channel';

/** @param {string[]} args */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** @param {string} name */
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function readPackage() {
  return JSON.parse(readFileSync(packageJson, 'utf8'));
}

function version() {
  const tags = gh(['api', `repos/${repo}/releases`, '--paginate', '--jq', '.[] | select(.draft | not) | select(.prerelease | not) | .tag_name'])
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
  const pkg = readPackage();
  const next = releaseVersion({ ref: env('GITHUB_REF'), runNumber: Number(env('GITHUB_RUN_NUMBER')), packageVersion: pkg.version, stableTags: tags });
  pkg.version = next;
  writeFileSync(packageJson, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(next);
}

/** The feed's version now, or null when the beta feed has none yet. @param {string} dir */
function currentBetaFeed(dir) {
  try {
    gh(['release', 'download', BETA_FEED_TAG, '-R', repo, '-p', 'latest.json', '-D', dir, '--clobber']);
  } catch {
    return null;
  }
  const file = join(dir, 'latest.json');
  if (!existsSync(file)) return null;
  const v = JSON.parse(readFileSync(file, 'utf8')).version;
  return typeof v === 'string' && parseSemver(v) ? v : null;
}

function publish() {
  const v = readPackage().version;
  const beta = /** @type {import('./semver.mjs').Semver} */ (parseSemver(v)).pre.length > 0;
  const tag = `v${v}`;
  const exe = join(nsisDir, `OtherBench_${v}_x64-setup.exe`);
  const sig = `${exe}.sig`;
  for (const f of [exe, sig]) if (!existsSync(f)) throw new Error(`${f} is missing: was the installer built with the updater key?`);

  const work = mkdtempSync(join(tmpdir(), 'otherbench-release-'));
  const manifest = join(work, 'latest.json');
  const notes = execFileSync('git', ['log', '-1', '--format=%s', env('GITHUB_SHA')], { encoding: 'utf8' }).trim();
  writeFileSync(
    manifest,
    `${JSON.stringify(
      updaterManifest({
        version: v,
        notes,
        pubDate: new Date().toISOString(),
        signature: readFileSync(sig, 'utf8').trim(),
        url: `https://github.com/${repo}/releases/download/${tag}/${basename(exe)}`,
      }),
      null,
      2
    )}\n`
  );

  gh([
    'release', 'create', tag, exe, sig, manifest, '-R', repo, '--target', env('GITHUB_SHA'),
    '--title', `OtherBench ${v}`, '--notes', notes,
    ...(beta ? ['--prerelease', '--latest=false'] : ['--latest']),
  ]);
  console.log(`published ${tag}`);
  if (!beta) return;

  try {
    gh(['release', 'view', BETA_FEED_TAG, '-R', repo, '--json', 'tagName']);
  } catch {
    gh([
      'release', 'create', BETA_FEED_TAG, '-R', repo, '--target', env('GITHUB_SHA'), '--prerelease', '--latest=false',
      '--title', 'Beta channel', '--notes', 'Holds the beta updater feed (latest.json). Not a release: install a vX.Y.Z-beta.N release instead.',
    ]);
  }
  const current = currentBetaFeed(mkdtempSync(join(tmpdir(), 'otherbench-feed-')));
  if (!shouldReplaceFeed(current, v)) {
    console.log(`beta feed stays on ${current}, which is newer than ${v}`);
    return;
  }
  gh(['release', 'upload', BETA_FEED_TAG, manifest, '-R', repo, '--clobber']);
  console.log(`beta feed now ${v}${current ? ` (was ${current})` : ''}`);
}

const command = process.argv[2];
if (command === 'version') version();
else if (command === 'publish') publish();
else throw new Error('Usage: publish.mjs version | publish');
