/**
 * The browser's branch of the permission broker (`../permissions.ts`,
 * `source: 'browser'`): its refusals before any card, its read pass under
 * ask_on_mutate, and the profile's site list. Its grants are pinned to one
 * host by the same rules as the sandbox network's (`grant-matching.ts`,
 * `grant-minting.ts`) and are never interchangeable with them.
 */
import { BROWSER_READ_COMMANDS, browserHostDenial } from '../browser-hosts.js';
import { siteListEntryFor } from '../browser-sites.js';
import { isUnattendedRun } from '../computer-apps.js';
import type { ToolContext } from '../../ports/tool-provider.js';
import type { Store } from '../../ports/store.js';
import type { ToolPolicy } from '../../types/config.js';
import type { Decision } from './decision.js';
import { stringField } from './fields.js';

/**
 * What the broker does with a browser call before the grants and a card, or
 * null to carry on to them.
 */
export function browserDecision(store: Store, args: unknown, policy: ToolPolicy, ctx: ToolContext, allowLoopbackPorts: readonly number[]): Decision | null {
  // The browser (spec 2026-10-12-model-browser-design): a call is about one
  // website, the `host` its describeCall worked out (a host the model sent
  // is thrown away before this). A blocked, local or private site is
  // refused before any card, and so is a call that names no site at all.
  const denial = browserHostDenial(stringField(args, 'host'), policy, { allowLoopbackPorts });
  if (denial) return { kind: 'deny', reason: denial };
  // Reading the open page needs no card under "ask on mutate". By command
  // name, never by declared risk (as for Claude Code's file reads). In a
  // scheduled run nobody sees which page that is (a granted site can redirect
  // anywhere), so a read there needs its site's own grant or site-list entry
  // like any other call; only `close`, which reads nothing, skips them.
  const command = stringField(args, 'command') ?? '';
  const readPass = isUnattendedRun(ctx) ? command === 'close' : BROWSER_READ_COMMANDS.has(command);
  if (policy.approvalMode === 'ask_on_mutate' && readPass) {
    return { kind: 'allow', grantedBy: 'auto_read' };
  }
  // The profile's site list: a standing grant for the websites it names,
  // under either approval mode, attended or not. Only reached once every
  // refusal above has passed, so it never lifts the plan gate, a blocked
  // site or a local or private address; and the proxy never reads it.
  const siteEntry = siteListEntry(store, stringField(args, 'host'), ctx);
  if (siteEntry !== null) return { kind: 'allow', grantedBy: 'site_list', siteEntry };
  return null;
}

/**
 * The entry of the reply's profile's browser site list that covers `host`,
 * or null. Read fresh from the store on every call, like the grants, so an
 * edit to the list applies to the very next call. The profile is
 * `ctx.profileId`, the one grants are matched under: for a sub-agent that is
 * its parent reply's profile, never the one it runs as.
 */
function siteListEntry(store: Store, host: string | null, ctx: ToolContext): string | null {
  return siteListEntryFor(host, store.profiles.get(ctx.profileId)?.browserAllowedSites ?? []);
}
