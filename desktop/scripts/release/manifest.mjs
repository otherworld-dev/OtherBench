// The `latest.json` tauri-plugin-updater reads, and the rule for replacing the beta feed's.
import { compareSemver } from './semver.mjs';

/**
 * @param {{ version: string, notes: string, pubDate: string, signature: string, url: string }} input
 */
export function updaterManifest({ version, notes, pubDate, signature, url }) {
  return { version, notes, pub_date: pubDate, platforms: { 'windows-x86_64': { signature, url } } };
}

/**
 * The beta feed never moves down: a slower build finishing after a newer one
 * must not put machines back on the older version. The same version replaces
 * it, though: that's a re-run of the release job, whose rebuilt installer has
 * a new signature, and the feed must carry the one that matches it.
 * @param {string | null} currentVersion the feed's version now, or null when it has none
 * @param {string} nextVersion
 */
export function shouldReplaceFeed(currentVersion, nextVersion) {
  return currentVersion === null || compareSemver(nextVersion, currentVersion) >= 0;
}
