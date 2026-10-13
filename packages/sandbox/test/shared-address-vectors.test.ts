import { describe, expect, it } from 'vitest';
import { SHARED_ADDRESS_VECTORS } from '@grunt/core/testing/shared-host-vectors.js';
// Plain ESM that ships into the VM; vitest loads it as it is.
import { isPrivateAddress } from '../resources/agent-core.mjs';

/**
 * The agent in the VM can't import core, so it keeps its own copy of the
 * address ranges. Core's shared table names the cases, with one answer each
 * for the browser (`isPublicAddress`, checked in core's
 * shared-host-vectors.test.ts) and for the agent. agent-addresses.test.ts
 * holds the copy to core's across every range.
 */
describe("the shared address vectors: the sandbox agent's side", () => {
  it('judges every resolved address the way the table says', () => {
    for (const v of SHARED_ADDRESS_VECTORS) expect(!isPrivateAddress(v.address), `${v.note}: ${v.address}`).toBe(v.reachable);
  });
});
