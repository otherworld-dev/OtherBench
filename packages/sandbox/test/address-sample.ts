import { V4_NOT_PUBLIC, V6_GLOBAL_NOT_PUBLIC } from '@grunt/core/domain/browser-hosts.js';
// Plain ESM that ships into the VM; vitest loads it as it is.
import { DENIED_RESOLVED_ADDRESSES } from '../resources/agent-core.mjs';

/**
 * The addresses the sandbox agent's reading of "private" is checked against
 * core's with (agent-addresses.test.ts), and the real runtime in the distro
 * against both (live.test.ts). The same every run: the random ones come from a
 * seeded generator.
 *
 * What is in it:
 *  - the first and last address of every range, and the one on each side of
 *    both. The ranges are core's two tables, the IPv6 forms that carry an IPv4
 *    address, every entry of the agent's DENIED_RESOLVED_ADDRESSES and the
 *    special blocks either side has ever differed on. A range that only one
 *    side knows still has its edges here;
 *  - every IPv4 /16 once, and random IPv4 addresses;
 *  - IPv4 addresses (the edges, a spread and random ones) in every IPv6 form
 *    that carries one, and in the forms that only look like it;
 *  - every first group of IPv6 twice, every second group under the first
 *    groups that hold special blocks, and random IPv6 addresses.
 */
export interface SampleAddress {
  /** One plain spelling: a dotted quad, or eight hex groups with nothing shortened. */
  text: string;
  family: 4 | 6;
  /** Its 32 or 128 bits as 0s and 1s, first bit first. */
  bits: string;
  /** `edge`, `carried`, `sweep` or `random`: where it came from. */
  kind: 'edge' | 'carried' | 'sweep' | 'random';
}

/** Eight 16-bit groups. */
type Groups = number[];
type Kind = SampleAddress['kind'];

/** A small seeded generator of 32-bit numbers (mulberry32): the same numbers every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const v4Text = (n: number): string => `${n >>> 24}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
const v6Text = (g: Groups): string => g.map((x) => x.toString(16)).join(':');
const v4Address = (n: number, kind: Kind): SampleAddress => ({ text: v4Text(n), family: 4, bits: (n >>> 0).toString(2).padStart(32, '0'), kind });
const v6Address = (g: Groups, kind: Kind): SampleAddress => ({ text: v6Text(g), family: 6, bits: g.map((x) => x.toString(2).padStart(16, '0')).join(''), kind });
const v4Number = (a: number, b: number, c: number, d: number): number => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

/** The groups of an IPv6 address written in hex groups, `::` allowed (no dotted tail, no zone). */
function v6Groups(text: string): Groups {
  const [head = '', tail] = text.split('::');
  const lead = head === '' ? [] : head.split(':');
  const rest = tail === undefined || tail === '' ? [] : tail.split(':');
  const all = [...lead, ...new Array<string>(tail === undefined ? 0 : 8 - lead.length - rest.length).fill('0'), ...rest].map((x) => parseInt(x, 16));
  if (all.length !== 8 || all.some((x) => !(x >= 0 && x <= 0xffff))) throw new Error(`Not an IPv6 address: ${text}`);
  return all;
}

export interface AddressRange {
  /** As it is written: `10.0.0.0/8`, `fc00::/7`. */
  entry: string;
  family: 4 | 6;
  address: string;
  prefix: number;
  /** The bits every address in the range starts with. */
  bits: string;
}

/** A CIDR range (`a.b.c.d/n` or IPv6 hex groups `/n`), read by hand: this is the tests' own reading, not the agent's. */
export function parseRange(entry: string): AddressRange {
  const [address = '', length = ''] = entry.split('/');
  if (!/^\d{1,3}$/.test(length)) throw new Error(`Not a range: ${entry}`);
  const prefix = Number(length);
  if (address.includes(':')) {
    if (prefix > 128) throw new Error(`Not a range: ${entry}`);
    return { entry, family: 6, address, prefix, bits: v6Address(v6Groups(address), 'edge').bits.slice(0, prefix) };
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((x) => !(x >= 0 && x <= 255)) || prefix > 32) throw new Error(`Not a range: ${entry}`);
  return { entry, family: 4, address, prefix, bits: v4Address(v4Number(parts[0]!, parts[1]!, parts[2]!, parts[3]!), 'edge').bits.slice(0, prefix) };
}

/** The first and last address of a range given as bits, and the neighbour on each side of both (those that exist). */
function edges(prefixBits: string, size: 32 | 128): string[] {
  const first = BigInt(`0b${prefixBits.padEnd(size, '0')}`);
  const last = BigInt(`0b${prefixBits.padEnd(size, '1')}`);
  const top = (1n << BigInt(size)) - 1n;
  return [first - 1n, first, first + 1n, last - 1n, last, last + 1n].filter((x) => x >= 0n && x <= top).map((x) => x.toString(2).padStart(size, '0'));
}

const groupsOfBits = (bits: string): Groups => Array.from({ length: 8 }, (_, i) => parseInt(bits.slice(i * 16, i * 16 + 16), 2));
const bitsOfGroups = (g: Groups, prefix: number): string => v6Address([...g, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8), 'edge').bits.slice(0, prefix);

/** The IPv6 forms that carry an IPv4 address (both sides judge these by it): where the address sits, and what is in front of it. */
const CARRIERS: readonly { name: string; lead: Groups; at: number }[] = [
  { name: 'v4-mapped', lead: [0, 0, 0, 0, 0, 0xffff], at: 6 },
  { name: 'NAT64', lead: [0x64, 0xff9b, 0, 0, 0, 0], at: 6 },
  { name: '6to4', lead: [0x2002], at: 1 },
];

/** IPv6 addresses that hold `n` the way a carrier does, and ones that only look like it (none of which is public). */
function carrying(n: number, random: () => number): Groups[] {
  const hi = n >>> 16;
  const lo = n & 0xffff;
  const r = (): number => random() & 0xffff;
  return [
    [0, 0, 0, 0, 0, 0xffff, hi, lo], // v4-mapped
    [0x64, 0xff9b, 0, 0, 0, 0, hi, lo], // NAT64
    [0x2002, hi, lo, 0, 0, 0, 0, 0], // 6to4
    [0x2002, hi, lo, r(), r(), r(), r(), r()], // 6to4, any host
    [0, 0, 0, 0, 0, 0, hi, lo], // v4-compatible (deprecated)
    [0, 0, 0, 0, 0xffff, 0, hi, lo], // v4-translated
    [0x64, 0xff9b, 1, 0, 0, 0, hi, lo], // NAT64's local-use prefix
    [0, 0, 0, 0, 1, 0xffff, hi, lo], // beside v4-mapped
    [0x64, 0xff9b, 0, 0, 0, 1, hi, lo], // beside NAT64
    [0x2003, hi, lo, 0, 0, 0, 0, 1], // beside 6to4: ordinary global unicast
  ];
}

/** Blocks either side has refused, allowed or differed on, whatever the tables say today. */
const NOTABLE_V6 = ['::/128', '::1/128', '::/96', '100::/64', '64:ff9b:1::/48', '2001::/32', '2001:10::/28', '2001:20::/28', '2001:db8::/32', '2620:4f:8000::/48', '3ffe::/16', '3fff::/20', '5f00::/16', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8'];
const NOTABLE_V4 = ['0.0.0.0/32', '8.8.8.8/32', '100.100.100.200/32', '168.63.129.16/32', '192.0.0.192/32', '192.88.99.0/24', '255.255.255.255/32'];
/** First groups whose every second group is tried: the ones that hold a special block or a form that carries IPv4. */
const SWEPT_FIRST_GROUPS = [0x64, 0x2001, 0x2002, 0x3fff];

export function* addressSample(size: 'full' | 'small' = 'full'): Generator<SampleAddress> {
  const random = seeded(0x6772756e);
  const group = (): number => random() & 0xffff;
  /** The small sample has every edge, and one in 64 of each sweep and of the random ones. */
  const step = size === 'small' ? 64 : 1;

  // IPv4: the edges of every range either side names.
  const v4Ranges = new Set<string>([
    ...V4_NOT_PUBLIC.map(([a, b, c, d, prefix]) => parseRange(`${a}.${b}.${c}.${d}/${prefix}`).bits),
    ...DENIED_RESOLVED_ADDRESSES.map(parseRange).flatMap((r) => (r.family === 4 ? [r.bits] : [])),
    ...NOTABLE_V4.map((entry) => parseRange(entry).bits),
  ]);
  const v4Edges = [...new Set([...v4Ranges].flatMap((bits) => edges(bits, 32)))].map((bits) => parseInt(bits, 2));
  for (const n of v4Edges) yield v4Address(n, 'edge');
  // Every /16 once, then anywhere.
  const spread: number[] = [];
  for (let hi = 0; hi < 0x10000; hi += step) {
    const n = ((hi << 16) | group()) >>> 0;
    if (hi % (16 * step) === 0) spread.push(n);
    yield v4Address(n, 'sweep');
  }
  const anywhere: number[] = [];
  for (let i = 0; i < 20_000; i += step) {
    const n = random();
    if (i < 2000) anywhere.push(n);
    yield v4Address(n, 'random');
  }

  // IPv4 inside IPv6.
  for (const n of [...v4Edges, ...spread, ...anywhere]) for (const g of carrying(n, random)) yield v6Address(g, 'carried');

  // IPv6: the edges of every range either side names.
  const v6Ranges = new Set<string>([
    bitsOfGroups([0x2000], 3),
    ...CARRIERS.map((c) => bitsOfGroups(c.lead, c.at * 16)),
    ...V6_GLOBAL_NOT_PUBLIC.map(([a, b, prefix]) => bitsOfGroups([a, b], prefix)),
    ...V4_NOT_PUBLIC.flatMap(([a, b, c, d, prefix]) => CARRIERS.map((carrier) => bitsOfGroups([...carrier.lead, (a << 8) | b, (c << 8) | d], carrier.at * 16 + prefix))),
    ...DENIED_RESOLVED_ADDRESSES.map(parseRange).flatMap((r) => (r.family === 6 ? [r.bits] : [])),
    ...NOTABLE_V6.map((entry) => parseRange(entry).bits),
  ]);
  for (const bits of new Set([...v6Ranges].flatMap((range) => edges(range, 128)))) yield v6Address(groupsOfBits(bits), 'edge');
  // Every first group, alone and with anything after it.
  for (let first = 0; first < 0x10000; first += step) {
    yield v6Address([first, 0, 0, 0, 0, 0, 0, 0], 'sweep');
    yield v6Address([first, group(), group(), group(), group(), group(), group(), group()], 'sweep');
  }
  // Every second group where the special blocks are.
  for (const first of SWEPT_FIRST_GROUPS) for (let second = 0; second < 0x10000; second += step) yield v6Address([first, second, group(), group(), group(), group(), group(), group()], 'sweep');
  // Anywhere, and anywhere in global unicast.
  for (let i = 0; i < 50_000; i += step) yield v6Address([group(), group(), group(), group(), group(), group(), group(), group()], 'random');
  for (let i = 0; i < 20_000; i += step) yield v6Address([0x2000 | (group() & 0x1fff), group(), group(), group(), group(), group(), group(), group()], 'random');
}

/** The longest run of zero groups as `::`, as an address is usually written. */
function shortened(g: Groups): string {
  let start = 0;
  let length = 0;
  for (let i = 0; i < 8; i += 1) {
    let end = i;
    while (end < 8 && g[end] === 0) end += 1;
    if (end - i > length) [start, length] = [i, end - i];
  }
  const text = (part: Groups): string => part.map((x) => x.toString(16)).join(':');
  return length < 2 ? text(g) : `${text(g.slice(0, start))}::${text(g.slice(start + length))}`;
}

/** Other ways of writing an address from the sample that mean the same address: both sides must read each as they read `address.text`. */
export function spellings(address: SampleAddress): string[] {
  if (address.family === 4) return [];
  const g = groupsOfBits(address.bits);
  const tail = v4Text(((g[6]! << 16) | g[7]!) >>> 0);
  const short = shortened(g);
  const shortLead = shortened([...g.slice(0, 6), 1, 1]).replace(/1:1$/, '');
  return [
    short,
    short.toUpperCase(),
    g.map((x) => x.toString(16).padStart(4, '0')).join(':'),
    `${address.text}%eth0`,
    `${short}%7`,
    `${g.slice(0, 6).map((x) => x.toString(16)).join(':')}:${tail}`,
    `${shortLead}${tail}`,
  ];
}

/** Characters that turn an address into something else, or into nothing. */
const NOISE = [' ', '\t', '\n', '[', ']', 'g', ':', '::', '.', '%', '/', '-', '0', '00', '1', 'f', 'x', '\u0000'];

/**
 * Text that mostly isn't an address: a fixed list, and addresses from the
 * sample with a character dropped, added or doubled. Some of it still reads
 * as an address. Both sides must give the same answer for every one.
 */
export function* almostAddresses(): Generator<string> {
  yield* ['', ' ', 'localhost', 'example.com', '1', '1.2', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.256', '010.0.0.1', '8.8.8.08', '1.2.3.-4', '1.2.3.4 ', ' 8.8.8.8', '8.8.8.8.', '.8.8.8.8', '0x8.8.8.8', '134744072'];
  yield* ['[::1]', '[2606:4700:4700::1111]', '[8.8.8.8]', '::ffff:1.2.3', '::ffff:1.2.3.4.5', '::ffff:256.1.1.1', '::ffff:01.2.3.4', '1::2::3', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', 'g::1', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:', ':', ':::', '::%', '%eth0'];
  yield* ['1.2.3.4%eth0', '8.8.8.8/32', '2606:4700::1111/128', '2606:4700::11111', '12345::1', '::1.2.3.4:5', '1.2.3.4::', '1:2:3:4:5:6:7:1.2.3.4', '1:2:3:4:5:6::1.2.3.4', '1:2:3:4:5::1.2.3.4', ':1.2.3.4', '::1.2.3.4', '2606:4700:4700::1111 ', '２６０６::1'];
  const random = seeded(0x61646472);
  for (const address of addressSample('small')) {
    for (const text of [address.text, ...spellings(address).slice(0, 1), ...spellings(address).slice(5)]) {
      const at = random() % (text.length + 1);
      const noise = NOISE[random() % NOISE.length]!;
      yield text.slice(0, at) + noise + text.slice(at);
      if (at < text.length) yield text.slice(0, at) + text.slice(at + 1);
      if (at < text.length) yield text.slice(0, at) + text[at]! + text.slice(at);
    }
  }
}

/** The eight 16-bit words of an IPv6 address in any spelling (`::`, a dotted IPv4 tail), or null. */
function wordsOfV6(text: string): number[] | null {
  let s = text;
  let tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const o = [dotted[2], dotted[3], dotted[4], dotted[5]].map(Number);
    if (o.some((n) => n > 255)) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    s = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (part: string): number[] | null => {
    if (part === '') return [];
    const out = part.split(':').map((w) => (/^[0-9a-f]{1,4}$/i.test(w) ? parseInt(w, 16) : NaN));
    return out.some(Number.isNaN) ? null : out;
  };
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  if (!head || !rest) return null;
  const fill = 8 - tail.length - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
}

/**
 * Whether `text` is `v4` itself or an IPv6 address that carries it: v4-mapped
 * (`::ffff:a.b.c.d`, dotted or hex), NAT64 (`64:ff9b::/96`) or 6to4 (`2002:ab:cd::/48`).
 * Strict: anything else, or text that isn't an address, is false.
 */
export function carriesV4(text: string, v4: string): boolean {
  const octets = v4.split('.').map(Number);
  const hi = (octets[0]! << 8) | octets[1]!;
  const lo = (octets[2]! << 8) | octets[3]!;
  if (text === v4) return true;
  const w = wordsOfV6(text);
  if (!w) return false;
  const zeros = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && w[5] === 0xffff) return w[6] === hi && w[7] === lo;
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return w[6] === hi && w[7] === lo;
  if (w[0] === 0x2002) return w[1] === hi && w[2] === lo;
  return false;
}
