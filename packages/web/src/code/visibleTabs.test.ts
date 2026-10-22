import { describe, expect, it } from 'vitest';
import { visibleTabs } from './visibleTabs.js';

const t = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('visibleTabs', () => {
  it('keeps the first tabs when the selected one fits', () => {
    const r = visibleTabs(t('a', 'b', 'c', 'd'), 'b', 2);
    expect([ids(r.shown), ids(r.overflow)]).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('gives the selected tab the last visible slot when it would overflow', () => {
    const r = visibleTabs(t('a', 'b', 'c', 'd'), 'd', 2);
    expect([ids(r.shown), ids(r.overflow)]).toEqual([['a', 'd'], ['b', 'c']]);
  });
  it('has no overflow when everything fits', () => {
    expect(visibleTabs(t('a', 'b'), 'a', 2).overflow).toEqual([]);
    expect(visibleTabs(t('a', 'b'), 'a', 5).overflow).toEqual([]);
  });
});
