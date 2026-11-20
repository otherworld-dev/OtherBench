/**
 * What `PermissionBroker.decide()` (`../permissions.ts`) answers for a tool
 * call, and how an allow is written to the audit trail. Every module of the
 * broker returns this one type, so a branch can only allow, deny or ask.
 */
import type { ApprovalRequest } from '../../ports/tool-provider.js';

export type Decision =
  /** `site_list`: the profile's browser site list covers the call's website; `siteEntry` is the entry that did. */
  /** `job`: a write in a job's folder, allowed by the job rules (permissions/job.ts). */
  | { kind: 'allow'; grantedBy: 'policy' | 'auto_read' | 'grant' | 'sandbox' | 'site_list' | 'job'; grantId?: string; siteEntry?: string }
  /** `plan`: refused while the reply's plan waits. `unattended`: refused because nobody is there (computer use). `job`: refused by a job's rules. */
  | { kind: 'deny'; reason: string; plan?: true; unattended?: true; job?: true; code?: 'not_approved' }
  | { kind: 'ask'; request: ApprovalRequest };

/**
 * How an allow is written to the audit trail: `grant:<id>` for a stored grant,
 * `site_list:<entry>` for the profile's browser site list (the Inspector shows
 * "profile site list"), otherwise the bare `grantedBy`.
 */
export function auditGrantedBy(decision: Extract<Decision, { kind: 'allow' }>): string {
  if (decision.grantedBy === 'site_list') return `site_list:${decision.siteEntry ?? ''}`;
  return decision.grantId ? `${decision.grantedBy}:${decision.grantId}` : decision.grantedBy;
}
