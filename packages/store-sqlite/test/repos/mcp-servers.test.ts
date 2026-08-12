import { describe, it, expect } from 'vitest';
import type { McpServer } from '@grunt/core/ports/store.js';
import { freshDb } from '../helpers.js';
import { SqliteMcpServerRepo } from '../../src/repos/mcp-servers.js';

function makeMcpServer(over: Partial<McpServer> & { id: string }): McpServer {
  return {
    name: 'Test MCP',
    transport: 'stdio',
    command: 'node',
    args: [],
    env: {},
    url: null,
    headerRefs: {},
    enabled: true,
    status: 'unknown',
    toolsCache: null,
    ...over,
  };
}

describe('SqliteMcpServerRepo', () => {
  it('create/get round-trips every field, including array/object JSON and a null toolsCache', () => {
    const db = freshDb();
    const repo = new SqliteMcpServerRepo(db);

    repo.create(
      makeMcpServer({
        id: 'mcp-a',
        name: 'My MCP Server',
        transport: 'http',
        command: null,
        args: ['--flag', 'value'],
        env: { KEY: 'value' },
        url: 'http://localhost:1234',
        headerRefs: { Authorization: 'secret://mcp-a-auth' },
        enabled: false,
        status: 'error',
      })
    );

    expect(repo.get('mcp-a')).toEqual({
      id: 'mcp-a',
      name: 'My MCP Server',
      transport: 'http',
      command: null,
      args: ['--flag', 'value'],
      env: { KEY: 'value' },
      url: 'http://localhost:1234',
      headerRefs: { Authorization: 'secret://mcp-a-auth' },
      enabled: false,
      status: 'error',
      toolsCache: null,
    });
    db.close();
  });

  it('round-trips a non-null toolsCache value', () => {
    const db = freshDb();
    const repo = new SqliteMcpServerRepo(db);
    repo.create(makeMcpServer({ id: 'mcp-a', toolsCache: { tools: [{ name: 'fs.read' }] } }));
    expect(repo.get('mcp-a')?.toolsCache).toEqual({ tools: [{ name: 'fs.read' }] });
    db.close();
  });

  it('list returns every created server', () => {
    const db = freshDb();
    const repo = new SqliteMcpServerRepo(db);
    repo.create(makeMcpServer({ id: 'mcp-a' }));
    repo.create(makeMcpServer({ id: 'mcp-b' }));
    expect(repo.list().map((s) => s.id).sort()).toEqual(['mcp-a', 'mcp-b']);
    db.close();
  });
});
