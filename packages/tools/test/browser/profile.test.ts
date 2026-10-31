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
