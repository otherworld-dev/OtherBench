import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeDesktopConfigError, claudeDesktopConfigPath, readClaudeDesktopServers } from '../src/mcp-import.js';

describe('claudeDesktopConfigPath', () => {
  it('finds the config where Claude Desktop keeps it on each platform, unless overridden', () => {
    expect(claudeDesktopConfigPath({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(claudeDesktopConfigPath({}, 'darwin', '/Users/a')).toBe(join('/Users/a', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    expect(claudeDesktopConfigPath({}, 'linux', '/home/a')).toBe(join('/home/a', '.config', 'Claude', 'claude_desktop_config.json'));
    expect(claudeDesktopConfigPath({ GRUNT_CLAUDE_DESKTOP_CONFIG: '/x/c.json', APPDATA: 'C:\\x' }, 'win32', 'C:\\Users\\a')).toBe('/x/c.json');
  });
});

describe('readClaudeDesktopServers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grunt-desktop-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (content: unknown): string => {
    const path = join(dir, 'claude_desktop_config.json');
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
    return path;
  };

  it('reads stdio and http servers, and lists anything else as not supported, with the reason', async () => {
    const path = write({
      preferences: {},
      mcpServers: {
        blender: { command: 'uvx', args: ['blender-mcp'] },
        'Home Assistant': { command: 'uvx', args: ['ha-mcp'], env: { HOMEASSISTANT_TOKEN: 'tok', HOMEASSISTANT_URL: 'http://ha' } },
        remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } },
        streamable: { type: 'streamable-http', url: 'https://mcp.example.com/s' },
        legacy: { type: 'sse', url: 'https://mcp.example.com/sse' },
        broken: 'nope',
        badEnv: { command: 'x', env: { N: 5 } },
        noCommand: { args: ['a'] },
        noUrl: { type: 'http' },
        odd: { type: 'websocket', url: 'ws://x' },
      },
    });
    const result = await readClaudeDesktopServers(path);
    if (!result.found) throw new Error('expected the file to be found');
    const byName = Object.fromEntries(result.servers.map((s) => [s.name, s]));
    expect(byName['blender']).toMatchObject({ transport: 'stdio', command: 'uvx', args: ['blender-mcp'], env: {}, supported: true });
    expect(byName['Home Assistant']).toMatchObject({ transport: 'stdio', env: { HOMEASSISTANT_TOKEN: 'tok', HOMEASSISTANT_URL: 'http://ha' }, supported: true });
    expect(byName['remote']).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' }, supported: true });
    expect(byName['streamable']).toMatchObject({ transport: 'http', supported: true });
    expect(byName['legacy']).toMatchObject({ supported: false, reason: expect.stringContaining('SSE') });
    expect(byName['broken']).toMatchObject({ supported: false, reason: expect.any(String) });
    expect(byName['badEnv']).toMatchObject({ supported: false, reason: expect.stringContaining('"N"') });
    expect(byName['noCommand']).toMatchObject({ supported: false, reason: expect.stringContaining('command') });
    expect(byName['noUrl']).toMatchObject({ supported: false, reason: expect.stringContaining('URL') });
    expect(byName['odd']).toMatchObject({ supported: false, reason: expect.stringContaining('websocket') });
  });

  it('copes with a byte-order mark and a config with no servers', async () => {
    expect(await readClaudeDesktopServers(write('\uFEFF{"mcpServers":{}}'))).toEqual({ found: true, servers: [] });
    expect(await readClaudeDesktopServers(write({ preferences: {} }))).toEqual({ found: true, servers: [] });
  });

  it('says a missing file is not found, and a file that is not JSON is an error naming it', async () => {
    expect(await readClaudeDesktopServers(join(dir, 'nothing-here.json'))).toEqual({ found: false });
    const bad = write('{ not json');
    await expect(readClaudeDesktopServers(bad)).rejects.toThrow(ClaudeDesktopConfigError);
    await expect(readClaudeDesktopServers(bad)).rejects.toThrow(bad);
  });
});
