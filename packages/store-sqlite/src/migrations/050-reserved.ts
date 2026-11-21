import type { Migration } from './types.js';

// Version 50 was used by three betas (0.2.0-beta.124 to 126) for tables that have since moved out of OtherBench.
// Databases that ran it keep their user_version of 50, so the number stays taken: this stub does nothing, and
// migration 051 tidies those databases up. Never reuse the number.
export const MIGRATION_050_RESERVED: Migration = {
  version: 50,
  name: '050-reserved',
};
