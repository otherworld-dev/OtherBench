import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Reading the MCP servers Claude Desktop is set up with, for Settings > MCP
 * servers > Import from Claude Desktop (spec
 * 2026-10-11-claude-code-clean-chat-and-mcp-design §3). Only the server ever
 * reads the file: env and header values (tokens, often) go straight into the
 * secret store on import and never reach the browser.
 */

/** Where Claude Desktop keeps its config on this machine. `GRUNT_CLAUDE_DESKTOP_CONFIG` overrides it (tests, e2e). */
export function claudeDesktopConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const override = env['GRUNT_CLAUDE_DESKTOP_CONFIG'];
  if (override) return override;
  if (platform === 'win32') return join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/** One `mcpServers` entry, read as Grunt would set it up. `env` and `headers` hold values: keep them on the server. */
export interface ClaudeDesktopServer {
  name: string;
  transport: 'stdio' | 'http' | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  supported: boolean;
  /** Why it can't be imported, when it can't. */
  reason?: string;
}

/** Claude Desktop's config is there but isn't valid JSON. */
export class ClaudeDesktopConfigError extends Error {}

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record of string values, or the name of the first entry that isn't one. */
function stringRecord(value: unknown): { ok: Record<string, string> } | { bad: string } {
  if (value === undefined) return { ok: {} };
  if (!isObject(value)) return { bad: '' };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return { bad: k };
    out[k] = v;
  }
  return { ok: out };
}

function parseEntry(name: string, raw: unknown): ClaudeDesktopServer {
  const base = { name, transport: null, command: null, args: [] as string[], env: {}, url: null, headers: {} };
  const unsupported = (reason: string): ClaudeDesktopServer => ({ ...base, supported: false, reason });
  if (!isObject(raw)) return unsupported('Not a server entry.');
  const type = raw['type'];
  if (type === 'sse') return unsupported("SSE servers aren't supported: Grunt connects over stdio or Streamable HTTP.");
  if (type === 'http' || type === 'streamable-http') {
    if (typeof raw['url'] !== 'string' || raw['url'].trim() === '') return unsupported('It has no URL.');
    const headers = stringRecord(raw['headers']);
    if ('bad' in headers) return unsupported(`Its header "${headers.bad}" isn't text.`);
    return { ...base, transport: 'http', url: raw['url'], headers: headers.ok, supported: true };
  }
  if (type !== undefined && type !== 'stdio') return unsupported(`Grunt doesn't support "${String(type)}" servers.`);
  if (typeof raw['command'] !== 'string' || raw['command'].trim() === '') return unsupported('It has no command to run.');
  const args = raw['args'];
  if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === 'string'))) return unsupported("Its arguments aren't a list of text.");
  const env = stringRecord(raw['env']);
  if ('bad' in env) return unsupported(`Its env value for "${env.bad}" isn't text.`);
  return { ...base, transport: 'stdio', command: raw['command'], args: (args as string[] | undefined) ?? [], env: env.ok, supported: true };
}

/** The servers in Claude Desktop's config at `path`; `found: false` when there is no file to read there. */
export async function readClaudeDesktopServers(path: string): Promise<{ found: false } | { found: true; servers: ClaudeDesktopServer[] }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { found: false };
  }
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new ClaudeDesktopConfigError(`Claude Desktop's config at ${path} isn't valid JSON.`);
  }
  const servers = isObject(json) && isObject(json['mcpServers']) ? Object.entries(json['mcpServers']) : [];
  return { found: true, servers: servers.map(([name, raw]) => parseEntry(name, raw)) };
}
