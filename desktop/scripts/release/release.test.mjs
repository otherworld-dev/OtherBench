import { describe, expect, test } from 'vitest';
import { compareSemver, parseSemver } from './semver.mjs';
import { releaseVersion } from './version.mjs';
import { shouldReplaceFeed, updaterManifest } from './manifest.mjs';

describe('releaseVersion', () => {
  test('a tag push releases exactly the tag', () => {
    expect(releaseVersion({ ref: 'refs/tags/v0.3.0', runNumber: 9, packageVersion: '0.2.0', stableTags: [] })).toBe('0.3.0');
  });

  test('a beta is a pre-release of the package version when that is ahead of every full release', () => {
    expect(releaseVersion({ ref: 'refs/heads/dev', runNumber: 7, packageVersion: '0.2.0', stableTags: ['v0.1.0'] })).toBe('0.2.0-beta.7');
  });

  test('once that version is released, betas move to the next patch', () => {
    expect(releaseVersion({ ref: 'refs/heads/dev', runNumber: 8, packageVersion: '0.2.0', stableTags: ['v0.2.0'] })).toBe('0.2.1-beta.8');
  });

  test('the highest full release wins whatever order GitHub lists them in', () => {
    expect(releaseVersion({ ref: 'refs/heads/dev', runNumber: 3, packageVersion: '0.1.0', stableTags: ['v0.9.1', 'v0.10.0', 'v0.1.0'] })).toBe('0.10.1-beta.3');
  });

  test('tags that are not full semver releases are ignored', () => {
    expect(releaseVersion({ ref: 'refs/heads/dev', runNumber: 4, packageVersion: '0.2.0', stableTags: ['dev-2026-10-15', 'beta-channel', 'v0.5.0-beta.2'] })).toBe('0.2.0-beta.4');
  });

  test('a tag that is not a version is refused, and so is any other branch', () => {
    expect(() => releaseVersion({ ref: 'refs/tags/dev-2026-10-15', runNumber: 1, packageVersion: '0.2.0', stableTags: [] })).toThrow(/not a release tag/);
    expect(() => releaseVersion({ ref: 'refs/tags/v0.3.0-beta.1', runNumber: 1, packageVersion: '0.2.0', stableTags: [] })).toThrow(/not a release tag/);
    expect(() => releaseVersion({ ref: 'refs/heads/main', runNumber: 1, packageVersion: '0.2.0', stableTags: [] })).toThrow(/only dev and v\* tags/);
  });
});

describe('semver', () => {
  test('precedence', () => {
    expect(compareSemver('0.2.0-beta.10', '0.2.0-beta.9')).toBe(1);
    expect(compareSemver('0.2.0', '0.2.0-beta.99')).toBe(1);
    expect(compareSemver('0.2.0-beta.1', '0.1.9')).toBe(1);
    expect(compareSemver('v0.2.0', '0.2.0')).toBe(0);
    expect(compareSemver('0.9.0', '0.10.0')).toBe(-1);
  });

  test('anything that is not a version does not parse', () => {
    expect(parseSemver('dev-2026-10-15')).toBeNull();
    expect(parseSemver('0.2')).toBeNull();
    expect(parseSemver('v1.2.3-beta.4')).toEqual({ major: 1, minor: 2, patch: 3, pre: ['beta', 4] });
  });
});

describe('the beta feed', () => {
  test('is only ever replaced by a higher version', () => {
    expect(shouldReplaceFeed(null, '0.2.0-beta.1')).toBe(true);
    expect(shouldReplaceFeed('0.2.0-beta.5', '0.2.0-beta.6')).toBe(true);
    expect(shouldReplaceFeed('0.2.0-beta.6', '0.2.0-beta.5')).toBe(false);
    expect(shouldReplaceFeed('0.2.0-beta.6', '0.2.0-beta.6')).toBe(false);
  });

  test('the manifest is what tauri-plugin-updater reads', () => {
    expect(updaterManifest({ version: '0.2.0-beta.7', notes: 'n', pubDate: '2026-10-29T12:00:00Z', signature: 'SIG', url: 'https://x/y.exe' })).toEqual({
      version: '0.2.0-beta.7',
      notes: 'n',
      pub_date: '2026-10-29T12:00:00Z',
      platforms: { 'windows-x86_64': { signature: 'SIG', url: 'https://x/y.exe' } },
    });
  });
});
