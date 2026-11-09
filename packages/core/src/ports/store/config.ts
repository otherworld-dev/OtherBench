import type { Connection, ModelInfo, Profile } from '../../types/config.js';

// --- connections ---------------------------------------------------------

export interface ConnectionRepo {
  create(c: Connection): Connection;
  get(id: string): Connection | null;
  list(): Connection[];
  update(id: string, patch: Partial<Omit<Connection, 'id'>>): Connection;
  delete(id: string): void;
}

// --- models ----------------------------------------------------------------

export interface ModelRepo {
  create(m: ModelInfo): ModelInfo;
  get(id: string): ModelInfo | null;
  list(connectionId?: string): ModelInfo[];
  update(id: string, patch: Partial<Omit<ModelInfo, 'id'>>): ModelInfo;
  delete(id: string): void;
}

// --- profiles ----------------------------------------------------------------

export interface ProfileRepo {
  create(p: Profile): Profile;
  get(id: string): Profile | null;
  list(): Profile[];
  update(id: string, patch: Partial<Omit<Profile, 'id'>>): Profile;
  delete(id: string): void;
}
