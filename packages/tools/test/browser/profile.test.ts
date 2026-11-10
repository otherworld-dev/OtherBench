import { describe, expect, it } from 'vitest';
import { FakeSecretStore } from '@otherbench/core/testing/fakes.js';
import { BrowserProfile, MAX_PROFILE_CHARS, mergeProfile, type ProfileState } from '../../src/browser/profile.js';

type Cookie = ProfileState['cookies'][number];
const cookie = (name: string, value = '1'): Cookie => ({ name, value, domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' });
const state = (cookies: Cookie[], origins: ProfileState['origins'] = []): ProfileState => ({ cookies, origins });
const site = (origin: string, value = 'v'): ProfileState['origins'][number] => ({ origin, localStorage: [{ name: 'k', value }] });

describe('mergeProfile', () => {
  it('adds and changes what the browser did, and keeps what another chat saved meanwhile', () => {
    const before = state([cookie('a')]);
    const stored = state([cookie('a'), cookie('other-chat')]);
    const merged = mergeProfile(stored, before, state([cookie('a', '2'), cookie('new')]));
    expect(merged.cookies.map((c) => [c.name, c.value]).sort()).toEqual([['a', '2'], ['new', '1'], ['other-chat', '1']]);
  });

  it("writes back only what the browser changed, so an unchanged copy never undoes another page's sign-out or change", () => {
    const before = state([cookie('session'), cookie('pref')], [site('https://a.test')]);
    // Another page signed out of `session` and changed `pref` and a.test's storage meanwhile.
    const stored = state([cookie('pref', '2')], [site('https://a.test', 'new')]);
    // This page changed nothing.
    expect(mergeProfile(stored, before, before)).toEqual(stored);
  });

  it('takes out what the browser removed, so signing out sticks', () => {
    const merged = mergeProfile(state([cookie('session')], [site('https://a.test')]), state([cookie('session')], [site('https://a.test')]), state([]));
    expect(merged).toEqual(state([]));
  });
});

describe('BrowserProfile', () => {
  it('starts empty, and gives back what was saved', async () => {
    const profile = new BrowserProfile(new FakeSecretStore());
    expect(await profile.load()).toEqual(state([]));
    await profile.save(profile.generation, state([]), state([cookie('a')]));
    expect((await profile.load()).cookies.map((c) => c.name)).toEqual(['a']);
  });

  it('keeps two saves at once from undoing each other', async () => {
    const profile = new BrowserProfile(new FakeSecretStore());
    await Promise.all([profile.save(0, state([]), state([cookie('one')])), profile.save(0, state([]), state([cookie('two')]))]);
    expect((await profile.load()).cookies.map((c) => c.name).sort()).toEqual(['one', 'two']);
  });

  // A chat's page and its sub-agents' pages are contexts like any two chats':
  // each loads the profile when it opens and folds its own changes back when it
  // closes, in whatever order they end.
  it("keeps every page's changes when a chat's page and its sub-agents' pages save in any order", async () => {
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0]];
    for (const order of orders) {
      const profile = new BrowserProfile(new FakeSecretStore());
      await profile.save(0, state([]), state([cookie('signed-in-before'), cookie('stale')], [site('https://kept.test')]));
      const opened = await profile.load();
      const ends: [ProfileState, ProfileState][] = [
        // The chat's own page signs in to one site.
        [opened, state([...opened.cookies, cookie('main-sign-in')], opened.origins)],
        // A sub-agent signs out (its cookie gone) and leaves the rest alone.
        [opened, state(opened.cookies.filter((c) => c.name !== 'stale'), opened.origins)],
        // Another sub-agent signs in elsewhere and changes a cookie the others still hold as it was.
        [opened, state([...opened.cookies.map((c) => (c.name === 'signed-in-before' ? cookie(c.name, '2') : c)), cookie('helper-sign-in')], [...opened.origins, site('https://helper.test')])],
      ];
      await Promise.all(order.map((i) => profile.save(0, ...ends[i]!)));
      const saved = await profile.load();
      expect(saved.cookies.map((c) => [c.name, c.value]).sort(), order.join()).toEqual([['helper-sign-in', '1'], ['main-sign-in', '1'], ['signed-in-before', '2']]);
      expect(saved.origins.map((o) => o.origin).sort()).toEqual(['https://helper.test', 'https://kept.test']);
    }
  });

  it('treats a damaged profile as empty rather than failing the browser', async () => {
    const secrets = new FakeSecretStore();
    await secrets.set('browser-profile', 'not json');
    expect(await new BrowserProfile(secrets).load()).toEqual(state([]));
  });

  it('after forget, a browser opened earlier has nothing to put back', async () => {
    const profile = new BrowserProfile(new FakeSecretStore());
    const opened = profile.generation;
    await profile.save(opened, state([]), state([cookie('a')]));
    await profile.forget();
    await profile.save(opened, state([]), state([cookie('a'), cookie('b')]));
    expect(await profile.load()).toEqual(state([]));
  });

  it('over the cap, drops the largest local storage and keeps every cookie', async () => {
    const profile = new BrowserProfile(new FakeSecretStore());
    await profile.save(0, state([]), state([cookie('a')], [site('https://small.test'), site('https://big.test', 'x'.repeat(MAX_PROFILE_CHARS))]));
    const loaded = await profile.load();
    expect(loaded.cookies).toHaveLength(1);
    expect(loaded.origins.map((o) => o.origin)).toEqual(['https://small.test']);
  });
});
