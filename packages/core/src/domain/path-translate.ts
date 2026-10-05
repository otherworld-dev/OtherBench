import type { CanonMessage, Part } from '../types/messages.js';
import type { LocationPath } from '../types/workspace.js';

/**
 * Translating other machines' folder paths in the copy of history sent to
 * the model (v2 plan, Task 45; spec §6). A tool call made on the PC names
 * `E:\Nextcloud\phd\notes.md`; replayed to a model running on the laptop,
 * that path should read `C:\Users\Adam\Nextcloud\phd\notes.md`, or the model
 * will reach for a folder that isn't there. Only the in-memory copy is
 * changed: stored history is never rewritten.
 */

/**
 * Every location root of the machine a message came from, as one pattern
 * (group i+1 matches `targets[i]`'s root; the group after them is the rest of
 * the path), and the same locations here.
 */
interface Translation {
  pattern: RegExp;
  targets: { to: string; sep: string }[];
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('//');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Characters a folder or file name can't contain here (separators included),
 * plus the ones that usually end a path in text: whitespace and quotes.
 */
const NAME_CHAR = '[^\\\\/\\s"\'`<>|:*?]';

/** `root` as a pattern: either separator between its segments, none after. */
function rootBody(root: string): string {
  return root
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .map(escapeRegExp)
    .join('[\\\\/]');
}

/**
 * The translation for messages from `originNode`: each location both
 * machines have a path for. The longest origin root comes first in the
 * pattern, so a nested location wins over the one containing it, and it's a
 * single pass, so a translated path is never translated again. Roots match at
 * a whole-segment boundary, ignoring case on a Windows machine. Null when the
 * two machines share no location.
 */
function translationFor(originNode: string, selfNodeId: string, paths: LocationPath[]): Translation | null {
  const pairs: { from: string; to: string }[] = [];
  for (const p of paths) {
    if (p.nodeId !== originNode) continue;
    const here = paths.find((q) => q.locationId === p.locationId && q.nodeId === selfNodeId);
    if (here) pairs.push({ from: p.path, to: here.path.replace(/[\\/]+$/, '') });
  }
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => b.from.length - a.from.length);
  const roots = pairs.map((p) => `(${rootBody(p.from)})`).join('|');
  const windows = pairs.every((p) => isWindowsPath(p.from));
  return {
    pattern: new RegExp(`(?:${roots})((?:[\\\\/]${NAME_CHAR}+)*)(?!${NAME_CHAR})`, windows ? 'gi' : 'g'),
    targets: pairs.map(({ to }) => ({ to, sep: isWindowsPath(to) ? '\\' : '/' })),
  };
}

/** `text` with every origin location path replaced by this machine's, in this machine's separators. */
function translateString(text: string, t: Translation): string {
  return text.replace(t.pattern, (...args: unknown[]) => {
    const groups = args.slice(1, t.targets.length + 2) as (string | undefined)[];
    const which = groups.findIndex((g, i) => i < t.targets.length && g !== undefined);
    const target = t.targets[which]!;
    const rest = groups[t.targets.length] ?? '';
    return target.to + rest.replace(/[\\/]/g, target.sep);
  });
}

/** Every string leaf of `value` translated; anything else as it was. */
function translateValue(value: unknown, t: Translation): unknown {
  if (typeof value === 'string') return translateString(value, t);
  if (Array.isArray(value)) return value.map((v) => translateValue(v, t));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, translateValue(v, t)]));
  }
  return value;
}

function translatePart(part: Part, t: Translation): Part {
  if (part.type === 'tool-call') return { ...part, args: translateValue(part.args, t) };
  if (part.type === 'tool-result') return { ...part, result: translateValue(part.result, t) };
  return part;
}

/**
 * `messages` as the model on `selfNodeId` should see them: in each message
 * another machine wrote, tool-call arguments and tool results have that
 * machine's location paths replaced with this machine's. Messages from this
 * machine, or with no location both machines know, are returned as they are.
 * Never mutates its input.
 */
export function translateForNode(messages: CanonMessage[], selfNodeId: string, paths: LocationPath[]): CanonMessage[] {
  const cache = new Map<string, Translation | null>();
  return messages.map((m) => {
    const origin = m.originNode;
    if (!origin || origin === selfNodeId) return m;
    if (!cache.has(origin)) cache.set(origin, translationFor(origin, selfNodeId, paths));
    const t = cache.get(origin);
    return t ? { ...m, parts: m.parts.map((p) => translatePart(p, t)) } : m;
  });
}
