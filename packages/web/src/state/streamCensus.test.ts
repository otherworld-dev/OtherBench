import { describe, expect, it, vi } from 'vitest';
import { StreamCensus, type CensusBus } from './streamCensus.js';

/** A BroadcastChannel between tabs: a message reaches every other tab, as the real one does, and not its sender. */
function hub() {
  const tabs: { cb: (m: unknown) => void; bus: CensusBus }[] = [];
  return {
    bus(): CensusBus {
      const entry = {
        cb: (_m: unknown) => {},
        bus: {
          post: (m: unknown) => {
            for (const t of tabs) if (t !== entry) t.cb(structuredClone(m));
          },
          onMessage: (cb: (m: unknown) => void) => {
            entry.cb = cb;
          },
        } as CensusBus,
      };
      tabs.push(entry);
      return entry.bus;
    },
  };
}

describe('StreamCensus', () => {
  it("adds up every tab's streams", () => {
    const h = hub();
    const a = new StreamCensus(h.bus(), 'a');
    const b = new StreamCensus(h.bus(), 'b');
    a.setOwn(3);
    b.setOwn(2);
    expect(a.ownCount()).toBe(3);
    expect(a.total()).toBe(5);
    expect(b.total()).toBe(5);
    a.setOwn(1);
    expect(b.total()).toBe(3);
  });

  it('a tab that opens later asks the others for their counts', () => {
    const h = hub();
    const a = new StreamCensus(h.bus(), 'a');
    a.setOwn(4);
    const b = new StreamCensus(h.bus(), 'b');
    expect(b.total()).toBe(4);
  });

  it('a tab that goes stops being counted, and counts again when it comes back', () => {
    const h = hub();
    const a = new StreamCensus(h.bus(), 'a');
    const b = new StreamCensus(h.bus(), 'b');
    b.setOwn(3);
    b.leave();
    expect(a.total()).toBe(0);
    b.rejoin();
    expect(a.total()).toBe(3);
  });

  it('tells its listeners when another tab changes', () => {
    const h = hub();
    const a = new StreamCensus(h.bus(), 'a');
    const b = new StreamCensus(h.bus(), 'b');
    const seen = vi.fn();
    const off = a.subscribe(seen);
    b.setOwn(1);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    b.setOwn(2);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('ignores what isn\'t a count', () => {
    let deliver: (m: unknown) => void = () => {};
    const a = new StreamCensus({ post: () => {}, onMessage: (cb) => (deliver = cb) }, 'a');
    for (const junk of [null, 'x', { tab: 1, count: 2 }, { tab: 'z', count: -1 }, { tab: 'z', count: 1.5 }, { tab: 'z', count: 1e9 }, { tab: 'a', count: 3 }]) deliver(junk);
    expect(a.total()).toBe(0);
  });

  it('works alone with no channel', () => {
    const a = new StreamCensus(null, 'a');
    a.setOwn(2);
    expect(a.total()).toBe(2);
  });
});
