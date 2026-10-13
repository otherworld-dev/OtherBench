import { BlockList, isIP } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress, V4_NOT_PUBLIC as CORE_V4_NOT_PUBLIC, V6_GLOBAL_NOT_PUBLIC as CORE_V6_GLOBAL_NOT_PUBLIC } from '@grunt/core/domain/browser-hosts.js';
// Plain ESM that ships into the VM; vitest loads it as it is.
import { DENIED_RESOLVED_ADDRESSES, isPrivateAddress, V4_NOT_PUBLIC, V6_GLOBAL_NOT_PUBLIC } from '../resources/agent-core.mjs';
import { addressSample, almostAddresses, parseRange, spellings } from './address-sample.js';

/**
 * One rule for which addresses are the public internet: core's
 * `isPublicAddress`. The agent in the VM can't import core, so it keeps a copy
 * of the two tables and of the reading of an address, and builds the ranges it
 * hands the runtime (`DENIED_RESOLVED_ADDRESSES`) from them. These tests are
 * what makes that one rule and not two: they fail when the copy and core
 * differ, and when the ranges and the copy do.
 */

/** The first few of a list of disagreements, with how many there were. */
const shown = (list: string[]): string[] => (list.length > 12 ? [...list.slice(0, 12), `... and ${list.length - 12} more`] : list);

const ranges = DENIED_RESOLVED_ADDRESSES.map(parseRange);

/** The tests' own matcher: the ranges of one family as a tree of bits. An address is in a range when walking its bits comes to the end of one. */
type Tree = { end?: true; 0?: Tree; 1?: Tree };
function treeOf(family: 4 | 6): Tree {
  const root: Tree = {};
  for (const r of ranges) {
    if (r.family !== family) continue;
    let node = root;
    for (const bit of r.bits) node = node[bit === '1' ? 1 : 0] ??= {};
    node.end = true;
  }
  return root;
}
function within(root: Tree, bits: string): boolean {
  let node: Tree | undefined = root;
  for (let i = 0; node !== undefined && !node.end && i < bits.length; i += 1) node = node[bits[i] === '1' ? 1 : 0];
  return node?.end === true;
}
/** ::ffff:0:0/96, the form that carries an IPv4 address in its last 32 bits. */
const V4_MAPPED = `${'0'.repeat(80)}${'1'.repeat(16)}`;

/** Node's BlockList, filled and asked exactly as the runtime does (its address.js: addSubnet per entry, check(address, family)). */
function runtimeBlockList(): BlockList {
  const list = new BlockList();
  for (const r of ranges) list.addSubnet(r.address, r.prefix, r.family === 4 ? 'ipv4' : 'ipv6');
  return list;
}

/** One walk over the whole sample: what each test below looks at. */
const found = {
  /** isPrivateAddress and !isPublicAddress disagree. */
  differ: [] as string[],
  count: { 4: { public: 0, private: 0 }, 6: { public: 0, private: 0 } },
  kinds: new Set<string>(),
  /** Private but outside the ranges (`missed`), or public but inside them (`extra`), by the tests' own matcher. */
  byPrefix: { missed: [] as string[], extra: [] as string[] },
  /** The same, as BlockList reads the ranges. */
  byBlockList: { missed: [] as string[], extra: [] as string[], asked: 0 },
};

beforeAll(() => {
  const v4Ranges = treeOf(4);
  const v6Ranges = treeOf(6);
  const blockList = runtimeBlockList();
  let seen = 0;
  for (const address of addressSample()) {
    const isPrivate = isPrivateAddress(address.text);
    if (isPrivate !== !isPublicAddress(address.text)) found.differ.push(address.text);
    found.count[address.family][isPrivate ? 'private' : 'public'] += 1;
    found.kinds.add(address.kind);
    // By hand: an address is covered when it starts with a range's bits. The one thing a range can't say: a
    // v4-mapped address has no IPv6 range of its own, it is covered by the IPv4 range of its last 32 bits.
    const byPrefix = address.family === 4 ? within(v4Ranges, address.bits) : within(v6Ranges, address.bits) || (address.bits.startsWith(V4_MAPPED) && within(v4Ranges, address.bits.slice(96)));
    if (byPrefix !== isPrivate) found.byPrefix[isPrivate ? 'missed' : 'extra'].push(address.text);
    // BlockList is slow to ask: every edge and every IPv4 address inside IPv6, one in 6 of the sweeps and the random ones.
    seen += 1;
    if (address.kind !== 'edge' && address.kind !== 'carried' && seen % 6 !== 0) continue;
    found.byBlockList.asked += 1;
    if (blockList.check(address.text, address.family === 4 ? 'ipv4' : 'ipv6') !== isPrivate) found.byBlockList[isPrivate ? 'missed' : 'extra'].push(address.text);
  }
});

describe("the sandbox agent's private addresses are core's", () => {
  it('keeps the same two tables of ranges as core', () => {
    expect(V4_NOT_PUBLIC).toEqual(CORE_V4_NOT_PUBLIC);
    expect(V6_GLOBAL_NOT_PUBLIC).toEqual(CORE_V6_GLOBAL_NOT_PUBLIC);
  });

  it('answers !isPublicAddress for every address in the sample: range edges, IPv4 inside IPv6, sweeps and seeded random ones', () => {
    expect(shown(found.differ)).toEqual([]);
    // The sample is big, and has plenty on both sides of the line in both families.
    expect([...found.kinds].sort()).toEqual(['carried', 'edge', 'random', 'sweep']);
    expect(found.count[4].public, 'public IPv4').toBeGreaterThan(50_000);
    expect(found.count[4].private, 'private IPv4').toBeGreaterThan(10_000);
    expect(found.count[6].public, 'public IPv6').toBeGreaterThan(200_000);
    expect(found.count[6].private, 'private IPv6').toBeGreaterThan(200_000);
  });

  it('has an address inside every range of both tables, in every form that carries it, and refuses it', () => {
    for (const [a, b, c, d] of CORE_V4_NOT_PUBLIC) {
      const v4 = `${a}.${b}.${c}.${d}`;
      for (const text of [v4, `::ffff:${v4}`, `64:ff9b::${v4}`, `2002:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}::1`]) {
        expect(isPublicAddress(text), text).toBe(false);
        expect(isPrivateAddress(text), text).toBe(true);
      }
    }
    for (const [a, b] of CORE_V6_GLOBAL_NOT_PUBLIC) {
      const text = `${a.toString(16)}:${b.toString(16)}::1`;
      expect(isPublicAddress(text), text).toBe(false);
      expect(isPrivateAddress(text), text).toBe(true);
    }
  });

  it('reads every other spelling of an address as core does, and as the plain one', () => {
    const differ: string[] = [];
    let tried = 0;
    for (const address of addressSample('small')) {
      const plain = isPrivateAddress(address.text);
      for (const text of spellings(address)) {
        tried += 1;
        if (isPrivateAddress(text) !== !isPublicAddress(text) || isPrivateAddress(text) !== plain) differ.push(`${text} (${address.text})`);
      }
    }
    expect(shown(differ)).toEqual([]);
    expect(tried).toBeGreaterThan(50_000);
  });

  it("answers as core does for text that isn't an address, or not quite one", () => {
    const differ: string[] = [];
    let tried = 0;
    let refused = 0;
    for (const text of almostAddresses()) {
      tried += 1;
      const isPrivate = isPrivateAddress(text);
      if (isPrivate) refused += 1;
      if (isPrivate !== !isPublicAddress(text)) differ.push(JSON.stringify(text));
    }
    expect(shown(differ)).toEqual([]);
    expect(tried).toBeGreaterThan(50_000);
    // Most of it is refused and some still reads as a public address: both answers are exercised.
    expect(refused).toBeGreaterThan(tried / 2);
    expect(tried - refused).toBeGreaterThan(1000);
  });

  it('refuses what is not text at all', () => {
    for (const value of [undefined, null, 42, 0x08080808, true, {}, [], ['8.8.8.8'], { address: '8.8.8.8' }]) expect(isPrivateAddress(value), JSON.stringify(value)).toBe(true);
  });
});

describe('the ranges the agent hands the runtime (DENIED_RESOLVED_ADDRESSES)', () => {
  it('is made of ranges the runtime takes: an address and a prefix length with nothing set after it, each once', () => {
    for (const r of ranges) {
      expect(isIP(r.address), r.entry).toBe(r.family);
      expect(r.prefix, r.entry).toBeLessThanOrEqual(r.family === 4 ? 32 : 128);
      expect(parseRange(`${r.address}/${r.family === 4 ? 32 : 128}`).bits.slice(r.prefix), r.entry).toMatch(/^0*$/);
    }
    expect(new Set(DENIED_RESOLVED_ADDRESSES).size).toBe(DENIED_RESOLVED_ADDRESSES.length);
  });

  it('holds no v4-mapped range, nor one that takes the v4-mapped form whole: the runtime reads the first as the IPv4 range itself, and the second would refuse every IPv4 address', () => {
    for (const r of ranges) if (r.family === 6) expect(r.bits.startsWith(V4_MAPPED) || V4_MAPPED.startsWith(r.bits), r.entry).toBe(false);
    // What it would do: BlockList matches an IPv4 address against an IPv6 range through its v4-mapped form.
    const wide = new BlockList();
    wide.addSubnet('::', 3, 'ipv6');
    expect(wide.check('8.8.8.8', 'ipv4')).toBe(true);
    expect(runtimeBlockList().check('8.8.8.8', 'ipv4')).toBe(false);
  });

  it("starts with core's IPv4 table as it stands, then the IPv6 ranges", () => {
    const v4 = CORE_V4_NOT_PUBLIC.map(([a, b, c, d, prefix]) => `${a}.${b}.${c}.${d}/${prefix}`);
    expect(DENIED_RESOLVED_ADDRESSES.slice(0, v4.length)).toEqual(v4);
    expect(ranges.slice(v4.length).every((r) => r.family === 6)).toBe(true);
    // The special blocks of global unicast by name, and each IPv4 range again inside NAT64 and 6to4.
    for (const [a, b, prefix] of CORE_V6_GLOBAL_NOT_PUBLIC) expect(ranges.map((r) => r.bits)).toContain(parseRange(`${a.toString(16)}:${b.toString(16)}::/${prefix}`).bits);
    for (const [a, b, c, d, prefix] of CORE_V4_NOT_PUBLIC) {
      const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
      expect(ranges.map((r) => r.bits), `NAT64 of ${a}.${b}.${c}.${d}/${prefix}`).toContain(parseRange(`64:ff9b::${hex}/${96 + prefix}`).bits);
      expect(ranges.map((r) => r.bits), `6to4 of ${a}.${b}.${c}.${d}/${prefix}`).toContain(parseRange(`2002:${hex}::/${16 + prefix}`).bits);
    }
  });

  it('covers every address isPrivateAddress refuses and no other, by a plain prefix match', () => {
    expect(shown(found.byPrefix.missed), 'private, but not in the ranges').toEqual([]);
    expect(shown(found.byPrefix.extra), 'in the ranges, but public').toEqual([]);
  });

  it("covers every address isPrivateAddress refuses and no other, as Node's BlockList (the runtime's matcher) reads the ranges", () => {
    expect(shown(found.byBlockList.missed), 'private, but not refused').toEqual([]);
    expect(shown(found.byBlockList.extra), 'refused, but public').toEqual([]);
    expect(found.byBlockList.asked).toBeGreaterThan(100_000);
  });

  it('still refuses everything the shorter list did: RFC 1918, CGNAT, unique local, multicast, reserved, benchmarking, loopback and link-local', () => {
    const blockList = runtimeBlockList();
    for (const text of ['10.0.0.1', '172.16.0.1', '192.168.0.1', '100.64.0.1', 'fc00::1', 'fd00::1', '224.0.0.1', '240.0.0.1', '198.18.0.1', '127.0.0.1', '169.254.169.254']) {
      expect(isPrivateAddress(text), text).toBe(true);
      expect(blockList.check(text, isIP(text) === 4 ? 'ipv4' : 'ipv6'), text).toBe(true);
    }
  });

  it('leaves the public internet alone: addresses like the ones the default hosts (and GitHub, which a profile may add) resolve to, in IPv4, IPv6 and behind NAT64', () => {
    const blockList = runtimeBlockList();
    // registry.npmjs.org (Cloudflare), pypi.org and files.pythonhosted.org (Fastly), plus GitHub's (github.com, codeload.github.com, *.githubusercontent.com), which a profile may still name itself.
    const v4 = ['104.16.0.35', '151.101.0.223', '151.101.64.223', '140.82.112.3', '140.82.121.9', '185.199.108.133'];
    const v6 = ['2606:4700::6810:23', '2a04:4e42::223', '2a04:4e42:400::223', '2606:50c0:8000::154', '2606:50c0:8003::154'];
    const nat64 = v4.map((text) => `64:ff9b::${text}`);
    for (const text of [...v4, ...v6, ...nat64]) {
      expect(isPublicAddress(text), text).toBe(true);
      expect(isPrivateAddress(text), text).toBe(false);
      expect(blockList.check(text, isIP(text) === 4 ? 'ipv4' : 'ipv6'), text).toBe(false);
    }
  });
});
