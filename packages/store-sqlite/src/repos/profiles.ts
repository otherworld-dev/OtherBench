import type { DatabaseSync } from 'node:sqlite';
import type { ProfileRepo } from '@grunt/core/ports/store.js';
import type { ModelParams, Profile, ToolPolicy } from '@grunt/core/types/config.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { fromBool, fromJson, toBool, toJson } from './util.js';

// `profile.model_id` deliberately has no FK to `model.id` -- see the module
// comment in migrations/001-initial.ts. It is free text naming a model the
// app may never have discovered, so the repo layer must not add validation
// that assumes a matching `model` row exists.
const mapping: CrudMapping<Profile> = {
  table: 'profile',
  columns: [
    'id',
    'name',
    'description',
    'colour',
    'connection_id',
    'model_id',
    'system_prompt',
    'params',
    'tool_policy',
    'is_default',
    'archived_at',
  ],
  toRow: (p) => [
    p.id,
    p.name,
    p.description,
    p.colour,
    p.connectionId,
    p.modelId,
    p.systemPrompt,
    toJson(p.params),
    toJson(p.toolPolicy),
    toBool(p.isDefault),
    p.archivedAt,
  ],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    description: row.description as string | null,
    colour: row.colour as string | null,
    connectionId: row.connection_id as string,
    modelId: row.model_id as string,
    systemPrompt: row.system_prompt as string | null,
    params: fromJson<ModelParams>(row.params as string),
    toolPolicy: fromJson<ToolPolicy>(row.tool_policy as string),
    isDefault: fromBool(row.is_default as number),
    archivedAt: row.archived_at as number | null,
  }),
};

export class SqliteProfileRepo implements ProfileRepo {
  private readonly crud: SqliteCrudRepo<Profile>;

  constructor(db: DatabaseSync) {
    this.crud = new SqliteCrudRepo(db, mapping);
  }

  create(p: Profile): Profile {
    return this.crud.create(p);
  }

  get(id: string): Profile | null {
    return this.crud.get(id);
  }

  list(): Profile[] {
    return this.crud.list();
  }

  update(id: string, patch: Partial<Omit<Profile, 'id'>>): Profile {
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
