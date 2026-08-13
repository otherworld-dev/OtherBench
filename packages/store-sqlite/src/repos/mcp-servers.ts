import type { DatabaseSync } from 'node:sqlite';
import type { McpServer, McpServerRepo } from '@grunt/core/ports/store.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { fromBool, fromJson, fromJsonNullable, toBool, toJson, toJsonNullable } from './util.js';

const mapping: CrudMapping<McpServer> = {
  table: 'mcp_server',
  columns: ['id', 'name', 'transport', 'command', 'args', 'env_refs', 'url', 'header_refs', 'enabled', 'status', 'tools_cache'],
  toRow: (s) => [
    s.id,
    s.name,
    s.transport,
    s.command,
    toJson(s.args),
    toJson(s.envRefs),
    s.url,
    toJson(s.headerRefs),
    toBool(s.enabled),
    s.status,
    toJsonNullable(s.toolsCache),
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    transport: row.transport as McpServer['transport'],
    command: row.command as string | null,
    args: fromJson<string[]>(row.args as string),
    envRefs: fromJson<Record<string, string>>(row.env_refs as string),
    url: row.url as string | null,
    headerRefs: fromJson<Record<string, string>>(row.header_refs as string),
    enabled: fromBool(row.enabled as number),
    status: row.status as McpServer['status'],
    toolsCache: fromJsonNullable(row.tools_cache as string | null),
  }),
};

export class SqliteMcpServerRepo implements McpServerRepo {
  private readonly crud: SqliteCrudRepo<McpServer>;

  constructor(db: DatabaseSync) {
    this.crud = new SqliteCrudRepo(db, mapping);
  }

  create(s: McpServer): McpServer {
    return this.crud.create(s);
  }

  get(id: string): McpServer | null {
    return this.crud.get(id);
  }

  list(): McpServer[] {
    return this.crud.list();
  }

  update(id: string, patch: Partial<Omit<McpServer, 'id'>>): McpServer {
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
