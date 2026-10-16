import type { DatabaseSync } from 'node:sqlite';
import type { PeerRepo } from '@otherbench/core/ports/store.js';
import type { Peer } from '@otherbench/core/types/peer.js';
import type { SqlBindValue } from './crud.js';
import { fromJson, toJson } from './util.js';

// Keyed on `node_id`, not `id`, so not built on SqliteCrudRepo.
const COLUMNS = ['node_id', 'name', 'fingerprint', 'addresses', 'issued_token_hash', 'held_token_ref', 'platform', 'last_seen_at', 'last_sync_seq', 'paired_at'];

function toRow(p: Peer): SqlBindValue[] {
  return [p.nodeId, p.name, p.fingerprint, toJson(p.addresses), p.issuedTokenHash, p.heldTokenRef, p.platform, p.lastSeenAt, p.lastSyncSeq, p.pairedAt];
}

function fromRow(row: Record<string, unknown>): Peer {
  return {
    nodeId: row.node_id as string,
    name: row.name as string,
    fingerprint: row.fingerprint as string,
    addresses: fromJson<string[]>(row.addresses as string),
    issuedTokenHash: row.issued_token_hash as string,
    heldTokenRef: row.held_token_ref as string,
    platform: row.platform as string,
    lastSeenAt: row.last_seen_at as number | null,
    lastSyncSeq: row.last_sync_seq as number,
    pairedAt: row.paired_at as number,
  };
}

/** Paired machines (migration 012). */
export class SqlitePeerRepo implements PeerRepo {
  constructor(private readonly db: DatabaseSync) {}

  private select(where: string, ...params: string[]): Peer[] {
    return (this.db.prepare(`SELECT * FROM peer ${where}`).all(...params) as Record<string, unknown>[]).map(fromRow);
  }

  list(): Peer[] {
    return this.select('ORDER BY paired_at ASC, node_id ASC');
  }

  get(nodeId: string): Peer | null {
    return this.select('WHERE node_id = ?', nodeId)[0] ?? null;
  }

  getByFingerprint(fingerprint: string): Peer | null {
    return this.select('WHERE fingerprint = ?', fingerprint)[0] ?? null;
  }

  /** A duplicate node id or fingerprint fails on the table's constraints. */
  create(p: Peer): Peer {
    this.db.prepare(`INSERT INTO peer (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`).run(...toRow(p));
    return { ...p, addresses: [...p.addresses] };
  }

  update(nodeId: string, patch: Partial<Omit<Peer, 'nodeId'>>): Peer {
    const current = this.get(nodeId);
    if (!current) throw new Error(`peer: not found: ${nodeId}`);
    const next: Peer = { ...current, ...patch, nodeId };
    const setClause = COLUMNS.slice(1)
      .map((c) => `${c} = ?`)
      .join(', ');
    this.db.prepare(`UPDATE peer SET ${setClause} WHERE node_id = ?`).run(...toRow(next).slice(1), nodeId);
    return next;
  }

  delete(nodeId: string): void {
    this.db.prepare('DELETE FROM peer WHERE node_id = ?').run(nodeId);
  }
}
