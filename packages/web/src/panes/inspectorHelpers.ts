import type { Profile } from '@otherbench/core/types/config.js';
import type { McpServerHealth } from '@otherbench/tools/mcp/manager.js';
import type { SummaryTone } from './InspectorSection.js';

export function formatCost(cost: number): string {
  return cost > 0 && cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/** Plain-language consequence of the current tool policy against a workspace that IS set -- makes real access legible, not just "a path is configured". */
export function workspaceConsequence(profile: Profile | null): string {
  const fs = profile?.toolPolicy.fs ?? 'off';
  const shell = profile?.toolPolicy.shell ?? false;
  if (fs === 'off' && !shell) {
    return "Files and shell are turned off by policy for this chat's profile, so tools won't run here (Settings > Profiles).";
  }
  const fsPart = fs === 'readwrite' ? 'read and write files' : fs === 'read' ? 'read files' : null;
  const parts = [fsPart, shell ? 'run shell commands' : null].filter((p): p is string => p !== null);
  return `Can ${parts.join(' and ')} here, with approval for each call.`;
}

/** The last segment of a native path, for a section summary. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * The MCP section's header line. With a profile, only the servers it has on
 * count towards a problem: one failing that this chat can't use shouldn't
 * flag every chat.
 */
export function mcpSummary(servers: McpServerHealth[] | null, failed: boolean, onIds: string[] | null): { text: string | null; tone: SummaryTone } {
  if (failed) return { text: "couldn't load", tone: 'warn' };
  if (servers === null) return { text: null, tone: 'normal' };
  if (servers.length === 0) return { text: 'none', tone: 'normal' };
  const relevant = onIds ? servers.filter((s) => onIds.includes(s.id)) : servers;
  const failing = relevant.filter((s) => s.enabled && s.status === 'error').length;
  const signIn = relevant.filter((s) => s.enabled && s.status === 'needs_auth').length;
  const parts = [onIds ? `${relevant.length} of ${servers.length} on` : String(servers.length)];
  if (failing > 0) parts.push(`${failing} failing`);
  if (signIn > 0) parts.push(`${signIn} need${signIn === 1 ? 's' : ''} sign-in`);
  return { text: parts.join(' · '), tone: failing > 0 ? 'danger' : signIn > 0 ? 'warn' : 'normal' };
}

export function formatAuditTime(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return new Date(createdAt).toLocaleTimeString();
}

/** Short, human label for how a gated call was authorised; the raw value stays available as a tooltip. Unknown values pass through. */
export function grantedByLabel(grantedBy: string): string {
  if (grantedBy.startsWith('grant:')) return 'grant';
  if (grantedBy.startsWith('live:')) return 'live artifact';
  if (grantedBy.startsWith('site_list:')) return 'profile site list';
  switch (grantedBy) {
    case 'auto_read': return 'auto-read';
    case 'policy': return 'policy';
    case 'ask:once': return 'asked: once';
    case 'ask:chat': return 'asked: this chat';
    case 'ask:always': return 'asked: always';
    case 'deny:policy': return 'denied by policy';
    case 'deny:user': return 'denied by you';
    case 'auto': return 'auto mode';
    case 'deny:cancelled': return 'stopped (not denied)';
    case 'deny:auto': return 'blocked by auto mode';
    case 'deny:plan': return 'refused: no plan approved yet';
    case 'deny:unattended': return 'refused: nobody to approve (scheduled run)';
    default: return grantedBy;
  }
}
