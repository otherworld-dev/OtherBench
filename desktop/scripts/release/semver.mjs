// Semver parsing and precedence for release versions (`X.Y.Z` and
// `X.Y.Z-beta.N`), with no dependency. An optional leading `v` is allowed so
// tag names can be passed as they are; build metadata is not.

const PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * @typedef {{ major: number, minor: number, patch: number, pre: (string | number)[] }} Semver
 */

/** @param {string} text @returns {Semver | null} */
export function parseSemver(text) {
  const m = PATTERN.exec(text);
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** @param {Semver} v */
export function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join('.')}` : ''}`;
}

/** @param {string | number} a @param {string | number} b */
function compareIdentifier(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  // Numeric identifiers sort below alphanumeric ones.
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence: -1, 0 or 1. A release outranks its own pre-releases.
 * @param {string} a @param {string} b @returns {-1 | 0 | 1}
 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const c = compareIdentifier(/** @type {string | number} */ (x.pre[i]), /** @type {string | number} */ (y.pre[i]));
    if (c !== 0) return /** @type {-1 | 1} */ (c);
  }
  return 0;
}
