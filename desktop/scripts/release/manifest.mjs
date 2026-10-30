// The `latest.json` tauri-plugin-updater reads, and the rule for replacing the beta feed's.
import { compareSemver } from './semver.mjs';

/**
 * @param {{ version: string, notes: string, pubDate: string, signature: string, url: string }} input
 */
export function updaterManifest({ version, notes, pubDate, signature, url }) {
  return { version, notes, pub_date: pubDate, platforms: { 'windows-x86_64': { signature, url } } };
}

/**
 * The beta feed only ever moves up: a slower build finishing after a newer
 * one must not put machines back on the older version.
 * @param {string | null} currentVersion the feed's version now, or null when it has none
 * @param {string} nextVersion
 */
export function shouldReplaceFeed(currentVersion, nextVersion) {
  return currentVersion === null || compareSemver(nextVersion, currentVersion) > 0;
}
