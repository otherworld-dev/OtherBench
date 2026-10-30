// The version a CI build is released as (docs/superpowers/specs/2026-10-29-auto-update-design.md).
import { compareSemver, formatSemver, parseSemver } from './semver.mjs';

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
