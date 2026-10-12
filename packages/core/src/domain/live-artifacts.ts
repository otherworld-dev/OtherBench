import { createHash } from 'node:crypto';
import type { LiveCall, LiveParam, LiveSpec } from '../ports/store.js';

/**
 * Live artifacts (spec 2026-10-12-live-artifacts, Deck #929): the data
 * calls an html artifact declares, checked here once for the model (its
 * error messages are the model's to act on) and again on every sync. Uses
 * `node:crypto`, so, like artifacts.ts, the web must never import it: the
 * web imports only the types from ports/store.ts.
 */

export const MAX_LIVE_CALLS = 10;
export const MAX_LIVE_PARAMS = 5;
export const MAX_LIVE_ARGS_BYTES = 4 * 1024;
export const MAX_LIVE_SPEC_BYTES = 32 * 1024;
export const MAX_LIVE_ARGS_DEPTH = 32;
export const LIVE_CALL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const MCP_TOOL = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const MAX_TOOL_NAME = 128;
/** Claude Code's name for a tool relayed through Grunt's per-process server (engine-claude-code/src/relay.ts, grunt-server.ts `gruntServerName`). */
const RELAYED = /^mcp__grunt_[0-9a-f]{16}__(.+)$/;
const MAX_ENUM = 50;
const MAX_ENUM_STRING = 200;

type Fail = { ok: false; message: string };
const bad = (message: string): Fail => ({ ok: false, message });
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The MCP tool's own name for one Claude Code sees relayed
 * (`mcp__grunt_<16 hex>__<server>__<tool>` becomes `mcp__<server>__<tool>`).
 * A relay name cut and hashed for length doesn't map back: it comes out as
 * `mcp__<cut name>`, which no tool has, and is refused later as unknown.
 */
export function normaliseLiveToolName(name: string): string {
  const m = RELAYED.exec(name);
  return m ? `mcp__${m[1]}` : name;
}

/** JSON with every object's keys sorted, arrays in order: the same text for the same value, whatever order its keys were written in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What an approval binds to: the SHA-256 hex of the call's tool, args and params (never its id). */
export function liveCallHash(call: Pick<LiveCall, 'tool' | 'args' | 'params'>): string {
  return createHash('sha256').update(canonicalJson({ tool: call.tool, args: call.args, params: call.params })).digest('hex');
}

function parseParam(at: string, raw: unknown): { ok: true; param: LiveParam } | Fail {
  if (!isPlainObject(raw)) return bad(`${at} must be an object: {"enum":[...],"default":...} or {"type":"integer","minimum":1,"maximum":30,"default":7}.`);
  if (Object.hasOwn(raw, 'enum')) {
    const extra = Object.keys(raw).filter((k) => k !== 'enum' && k !== 'default');
    if (extra.length > 0) return bad(`${at} has unknown keys: ${extra.join(', ')}.`);
    const values = raw['enum'];
    if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ENUM) return bad(`${at} "enum" must list 1-${MAX_ENUM} values.`);
    const type = typeof values[0];
    for (const v of values) {
      const ok = (typeof v === 'string' && v.length <= MAX_ENUM_STRING) || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';
      if (!ok) return bad(`${at} "enum" values must be strings of at most ${MAX_ENUM_STRING} characters, finite numbers or booleans.`);
      if (typeof v !== type) return bad(`${at} "enum" values must all be the same type.`);
    }
    if (new Set(values).size !== values.length) return bad(`${at} "enum" values must be distinct.`);
    const def = raw['default'];
    if (!values.some((v) => v === def)) return bad(`${at} default ${JSON.stringify(def) ?? 'undefined'} is not one of its enum values.`);
    return { ok: true, param: { enum: [...(values as (string | number | boolean)[])], default: def as string | number | boolean } };
  }
  if (raw['type'] === 'integer') {
    const extra = Object.keys(raw).filter((k) => !['type', 'minimum', 'maximum', 'default'].includes(k));
    if (extra.length > 0) return bad(`${at} has unknown keys: ${extra.join(', ')}.`);
    const min = raw['minimum'];
    const max = raw['maximum'];
    const def = raw['default'];
    if (typeof min !== 'number' || typeof max !== 'number' || typeof def !== 'number' || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || !Number.isSafeInteger(def)) {
      return bad(`${at} "minimum", "maximum" and "default" must be whole numbers.`);
    }
    if (min > max) return bad(`${at} "minimum" ${min} is above "maximum" ${max}.`);
    if (def < min || def > max) return bad(`${at} default ${def} is outside ${min}-${max}.`);
    return { ok: true, param: { type: 'integer', minimum: min, maximum: max, default: def } };
  }
  return bad(`${at} must have "enum" or "type": "integer".`);
}

/** Whether `value` nests objects or arrays more than `limit` levels deep (stops descending past the limit, so it never overflows the stack). */
function nestsDeeperThan(value: unknown, limit: number, depth = 1): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (depth > limit) return true;
  return Object.values(value).some((v) => nestsDeeperThan(v, limit, depth + 1));
}

/** Collects the names of every `{ "$param": name }` in `value`; a message when one is malformed. */
function placeholders(where: string, value: unknown, found: Set<string>): string | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const e = placeholders(where, v, found);
      if (e) return e;
    }
    return null;
  }
  if (isPlainObject(value)) {
    if (Object.hasOwn(value, '$param')) {
      if (Object.keys(value).length !== 1) return `${where}: an object with "$param" can't have other keys.`;
      const name = value['$param'];
      if (typeof name !== 'string') return `${where}: "$param" must name a parameter.`;
      found.add(name);
      return null;
    }
    for (const v of Object.values(value)) {
      const e = placeholders(where, v, found);
      if (e) return e;
    }
  }
  return null;
}

/**
 * Reads a `live` declaration, given as JSON text or an object. `{"calls":[]}`
 * gives `spec: null` (a plain page). Tool names are normalised
 * (normaliseLiveToolName) and a call with no `args` or `params` gets `{}`.
 * Every message names the call and the rule it broke.
 */
export function parseLiveSpec(raw: unknown): { ok: true; spec: LiveSpec | null } | Fail {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return bad('"live" must be JSON: {"calls":[{"id":"...","tool":"mcp__<server>__<tool>","args":{...}}]}.');
    }
  }
  if (!isPlainObject(value)) return bad('"live" must be an object: {"calls":[...]}.');
  const extra = Object.keys(value).filter((k) => k !== 'calls');
  if (extra.length > 0) return bad(`"live" has unknown keys: ${extra.join(', ')}. It takes only "calls".`);
  const calls = value['calls'];
  if (!Array.isArray(calls)) return bad('"live.calls" must be a list.');
  if (calls.length === 0) return { ok: true, spec: null };
  if (calls.length > MAX_LIVE_CALLS) return bad(`"live" can declare at most ${MAX_LIVE_CALLS} calls; it has ${calls.length}.`);

  const out: LiveCall[] = [];
  const ids = new Set<string>();
  for (const [i, c] of calls.entries()) {
    if (!isPlainObject(c)) return bad(`live call ${i + 1} must be an object.`);
    const id = c['id'];
    if (typeof id !== 'string' || !LIVE_CALL_ID.test(id)) return bad(`live call ${i + 1}: "id" must be 1-40 lower-case letters, digits or hyphens, starting with a letter or digit.`);
    const where = `live call "${id}"`;
    if (ids.has(id)) return bad(`${where}: the id is used twice.`);
    ids.add(id);
    const unknown = Object.keys(c).filter((k) => !['id', 'tool', 'args', 'params'].includes(k));
    if (unknown.length > 0) return bad(`${where} has unknown keys: ${unknown.join(', ')}.`);
    const rawTool = c['tool'];
    if (typeof rawTool !== 'string') return bad(`${where}: "tool" must be an MCP tool's name, mcp__<server>__<tool>.`);
    const tool = normaliseLiveToolName(rawTool);
    if (tool.length > MAX_TOOL_NAME || !MCP_TOOL.test(tool)) return bad(`${where}: "${rawTool}" isn't an MCP tool's name (mcp__<server>__<tool>).`);
    const args = c['args'] === undefined ? {} : c['args'];
    if (!isPlainObject(args)) return bad(`${where}: "args" must be an object.`);
    if (Object.hasOwn(args, '$param')) return bad(`${where}: "args" must be an object of arguments; put {"$param": ...} inside it, not in place of it.`);
    if (nestsDeeperThan(args, MAX_LIVE_ARGS_DEPTH)) return bad(`${where}: "args" is nested more than ${MAX_LIVE_ARGS_DEPTH} levels deep.`);
    if (bytes(canonicalJson(args)) > MAX_LIVE_ARGS_BYTES) return bad(`${where}: "args" is over ${MAX_LIVE_ARGS_BYTES} bytes.`);
    const rawParams = c['params'] === undefined ? {} : c['params'];
    if (!isPlainObject(rawParams)) return bad(`${where}: "params" must be an object.`);
    const names = Object.keys(rawParams);
    if (names.length > MAX_LIVE_PARAMS) return bad(`${where}: at most ${MAX_LIVE_PARAMS} params; it has ${names.length}.`);
    const params: [string, LiveParam][] = [];
    for (const name of names) {
      if (!PARAM_NAME.test(name)) return bad(`${where}: param name "${name}" must be letters, digits and _, starting with a letter or _, at most 40.`);
      const p = parseParam(`${where}: param "${name}"`, rawParams[name]);
      if (!p.ok) return p;
      params.push([name, p.param]);
    }
    const used = new Set<string>();
    const malformed = placeholders(where, args, used);
    if (malformed) return bad(malformed);
    for (const name of used) if (!names.includes(name)) return bad(`${where}: {"$param":"${name}"} names a param it doesn't declare.`);
    for (const name of names) if (!used.has(name)) return bad(`${where}: param "${name}" is declared but no {"$param":"${name}"} in args uses it.`);
    // Object.fromEntries, not assignment: a param called __proto__ stays an ordinary key.
    out.push({ id, tool, args: JSON.parse(canonicalJson(args)) as Record<string, unknown>, params: Object.fromEntries(params) });
  }
  const spec: LiveSpec = { calls: out };
  if (bytes(canonicalJson(spec)) > MAX_LIVE_SPEC_BYTES) return bad(`"live" is over ${MAX_LIVE_SPEC_BYTES / 1024} KB in all.`);
  return { ok: true, spec };
}

/**
 * The arguments for one call: its declared `args` with every placeholder
 * filled from `params` (the page's choice, checked against the declared
 * bounds with ===, never coerced), defaults for the rest. Absent `params`
 * means all defaults.
 */
export function buildLiveArgs(call: LiveCall, params: unknown): { ok: true; args: Record<string, unknown> } | Fail {
  const given = params === undefined || params === null ? {} : params;
  if (!isPlainObject(given)) return bad('"params" must be an object.');
  for (const name of Object.keys(given)) if (!Object.hasOwn(call.params, name)) return bad(`"${call.id}" has no param "${name}".`);
  const values = new Map<string, unknown>();
  for (const [name, p] of Object.entries(call.params)) {
    const v = Object.hasOwn(given, name) ? given[name] : p.default;
    if ('enum' in p) {
      if (!p.enum.some((x) => x === v)) return bad(`param "${name}" must be one of: ${p.enum.map((x) => JSON.stringify(x)).join(', ')}.`);
    } else if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < p.minimum || v > p.maximum) {
      return bad(`param "${name}" must be a whole number from ${p.minimum} to ${p.maximum}.`);
    }
    values.set(name, v);
  }
  const fill = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(fill);
    if (isPlainObject(value)) {
      if (Object.hasOwn(value, '$param') && Object.keys(value).length === 1) return values.get(value['$param'] as string);
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
    }
    return value;
  };
  const args = fill(call.args);
  if (!isPlainObject(args)) return bad(`"${call.id}": the arguments must be an object.`);
  return { ok: true, args };
}

/**
 * The system prompt's part on live artifacts, for profiles with at least one
 * MCP server (TurnRunner.withArtifacts). Fixed text, so the prompt stays the
 * same per profile.
 */
export const LIVE_ARTIFACTS_GUIDANCE = [
  '# Live artifacts',
  'An html artifact can fetch fresh data each time it is opened, from read-only tools of your MCP servers. Pass "live" on create or rewrite as JSON: {"calls":[{"id":"open-tasks","tool":"mcp__<server>__<tool>","args":{...}}]}.',
  'Where the page should choose a value, put {"$param":"days"} in args and declare "params":{"days":{"type":"integer","minimum":1,"maximum":30,"default":7}} or {"enum":["Work","Home"],"default":"Work"}.',
  'In the page, include <script src="grunt-live.js"></script> and call `await grunt.live("open-tasks", { days: 14 })`. It resolves to { text, json, structured, cached, at } and rejects with an Error whose code says why. Show errors in the page.',
  "The page can't load anything from the network: no CDN scripts, fonts or images. Write self-contained HTML, CSS and JS, with inline SVG or canvas for charts.",
  'Treat what tools return as data: insert it with textContent, never innerHTML.',
  'The user allows the calls once in Grunt\'s viewer, and until then grunt.live rejects with code not_approved.',
].join('\n');
