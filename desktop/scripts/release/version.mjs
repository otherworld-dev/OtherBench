// The version a CI build is released as (docs/superpowers/specs/2026-10-29-auto-update-design.md).
import { compareSemver, formatSemver, parseSemver } from './semver.mjs';

/**
 * The version a hand-built installer (`npm run app:installer`) carries:
 * `X.Y.Z-alpha.local.<YYYYMMDDHHmm>`, local time. `alpha` sorts below `beta`,
 * so it ranks under every beta of the package version (and under the next
 * patch's), and the updater moves a machine on to the next beta. A plain
 * `X.Y.Z` outranked every `X.Y.Z-beta.N`, so a hand install never updated
 * again (2026-11-02, 2026-11-15).
 *
 * @param {{ packageVersion: string, now: Date }} input
 * @returns {string}
 */
export function localVersion({ packageVersion, now }) {
  const pkg = parseSemver(packageVersion);
  if (!pkg || pkg.pre.length) throw new Error(`desktop/package.json's version ${packageVersion} must be X.Y.Z`);
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}${two(now.getHours())}${two(now.getMinutes())}`;
  return `${formatSemver(pkg)}-alpha.local.${stamp}`;
}

/**
 * A `vX.Y.Z` tag releases exactly `X.Y.Z`. A push to `dev` releases a beta of
 * the next full version: `desktop/package.json`'s version while that is ahead
 * of every full release, else the newest full release with its patch bumped.
 * The newest is the highest version among `stableTags`, never the first one
 * listed: GitHub doesn't list releases in version order.
 *
 * @param {{ ref: string, runNumber: number, packageVersion: string, stableTags: string[] }} input
 * @returns {string}
 */
export function releaseVersion({ ref, runNumber, packageVersion, stableTags }) {
  if (ref.startsWith('refs/tags/')) {
    const tag = ref.slice('refs/tags/'.length);
    const v = tag.startsWith('v') ? parseSemver(tag) : null;
    if (!v || v.pre.length) throw new Error(`${tag} is not a release tag (expected vX.Y.Z)`);
    return formatSemver(v);
  }
  if (ref !== 'refs/heads/dev') throw new Error(`Releases are made from only dev and v* tags, not ${ref}`);

  const pkg = parseSemver(packageVersion);
  if (!pkg || pkg.pre.length) throw new Error(`desktop/package.json's version ${packageVersion} must be X.Y.Z`);
  const stable = stableTags.filter((t) => parseSemver(t)?.pre.length === 0).sort(compareSemver).at(-1);
  let base = pkg;
  if (stable && compareSemver(packageVersion, stable) <= 0) {
    const s = /** @type {import('./semver.mjs').Semver} */ (parseSemver(stable));
    base = { major: s.major, minor: s.minor, patch: s.patch + 1, pre: [] };
  }
  return `${formatSemver(base)}-beta.${runNumber}`;
}
