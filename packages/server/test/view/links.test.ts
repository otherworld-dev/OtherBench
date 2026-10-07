import { describe, expect, it } from 'vitest';
import { MAX_VIEW_LINKS, VIEW_LINK_TTL_MS, ViewLinks } from '../../src/view/links.js';

const link = { chatId: 'c1', root: '/ws', target: '/ws/a.png', scope: 'file' as const };

describe('ViewLinks', () => {
  it('gives each link an unguessable id and finds it again until it expires', () => {
    let now = 1_000;
    const links = new ViewLinks(() => now);
    const a = links.create(link);
    const b = links.create(link);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
    expect(links.get(a)).toEqual({ ...link, expiresAt: 1_000 + VIEW_LINK_TTL_MS });
    now += VIEW_LINK_TTL_MS - 1;
    expect(links.get(a)).not.toBeNull();
    now += 1;
    expect(links.get(a)).toBeNull();
    expect(links.get('nope')).toBeNull();
  });

  it('keeps at most MAX_VIEW_LINKS, dropping the oldest', () => {
    const links = new ViewLinks(() => 0);
    const first = links.create(link);
    for (let i = 0; i < MAX_VIEW_LINKS; i++) links.create(link);
    expect(links.get(first)).toBeNull();
  });
});
