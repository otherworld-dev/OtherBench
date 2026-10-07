import { describe, expect, it } from 'vitest';
import { MAX_VIEW_LINKS, VIEW_LINK_TTL_MS, ViewLinks } from '../../src/view/links.js';

const link = { chatId: 'c1', root: '/ws', target: '/ws/a.png', scope: 'file' as const };

describe('ViewLinks', () => {
  it('gives each link an unguessable id and finds it again until it goes unused for its whole life', () => {
    let now = 1_000;
    const links = new ViewLinks(() => now);
    const a = links.create(link);
    const b = links.create(link);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
    now += VIEW_LINK_TTL_MS;
    expect(links.get(b)).toBeNull();
    expect(links.get('nope')).toBeNull();
  });

  it("lives ten minutes from its last use, so a page's late loads (lazy images, a click to another page) still work", () => {
    let now = 0;
    const links = new ViewLinks(() => now);
    const a = links.create(link);
    for (let i = 1; i <= 3; i++) {
      now = i * (VIEW_LINK_TTL_MS - 1);
      expect(links.get(a), `use ${i}`).toMatchObject(link);
    }
    now += VIEW_LINK_TTL_MS;
    expect(links.get(a)).toBeNull();
  });

  it('keeps at most MAX_VIEW_LINKS, dropping the oldest', () => {
    const links = new ViewLinks(() => 0);
    const first = links.create(link);
    for (let i = 0; i < MAX_VIEW_LINKS; i++) links.create(link);
    expect(links.get(first)).toBeNull();
  });
});
