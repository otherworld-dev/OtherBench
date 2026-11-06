/**
 * Tier 1 of the permission broker (`../permissions.ts`): the profile's
 * `ToolPolicy` as a hard ceiling. `checkPolicy` is the first thing `decide()`
 * asks of every call except a live one, which asks it through
 * `liveIneligibility`; a call it refuses gets no card, and no grant can
 * override it.
 */
import { agentPolicyDenial } from '../agent-tools.js';
import { COMPUTER_OFF_REASON } from '../computer-apps.js';
import { CHAT_MESSAGES_OFF_REASON } from '../chat-sends.js';
import type { ToolSpec } from '../../ports/tool-provider.js';
import { runsShellInSandbox, type ToolPolicy } from '../../types/config.js';

/** A media call on a profile with no choice set for it, or under a tool name OtherBench doesn't know. */
export const MEDIA_OFF_REASON = "Generation isn't set up for this profile.";

/** The profile's choice a media tool needs: `generate_image` the image one, `generate_video` the video one, any other name none. */
function mediaChoiceFor(name: string, policy: ToolPolicy): unknown {
  if (name === 'generate_image') return policy.media?.image;
  if (name === 'generate_video') return policy.media?.video;
  return undefined;
}

export function checkPolicy(tool: ToolSpec, policy: ToolPolicy): string | null {
  switch (tool.source) {
    case 'fs':
      if (policy.fs === 'off') return 'Filesystem tools are disabled by policy.';
      if (tool.risk === 'mutate' && policy.fs !== 'readwrite') {
        return `"${tool.name}" mutates the filesystem, but policy only permits read access.`;
      }
      return null;
    case 'shell':
      if (!policy.shell) return 'Shell execution is disabled by policy.';
      if (policy.shellRuns === 'sandbox') return 'This profile runs shell commands in the sandbox, not on this machine.';
      return null;
    case 'sandbox':
    case 'network':
      return runsShellInSandbox(policy) ? null : "This profile doesn't run shell commands in the sandbox.";
    case 'mcp': {
      if (policy.mcpServerIds.length === 0) return 'No MCP servers are enabled by policy.';
      // "Some server is enabled" is not "THIS tool's server is enabled".
      // Checking only the former meant a tool from a server the user had
      // never enabled was allowed the moment any other server was -- and
      // read-risk MCP tools then took the auto-approval shortcut (sources.ts) on
      // the strength of that same non-check. A tool that does not say where
      // it came from cannot be checked at all, so it is denied rather than
      // given the benefit of the doubt.
      if (!tool.serverId) {
        return `"${tool.name}" does not declare which MCP server it came from, so it cannot be checked against the enabled-server list.`;
      }
      if (!policy.mcpServerIds.includes(tool.serverId)) {
        return `"${tool.name}" comes from MCP server "${tool.serverId}", which this profile does not enable.`;
      }
      return null;
    }
    case 'agent':
      return agentPolicyDenial(tool.name, policy);
    case 'artifact':
      return policy.artifacts === false ? 'Artifacts are turned off for this profile.' : null;
    case 'recall':
      return policy.recall === false ? 'Searching past chats is turned off for this profile.' : null;
    case 'chats':
      return policy.chatMessages === false ? CHAT_MESSAGES_OFF_REASON : null;
    case 'thread':
      return null;
    case 'subagent':
      return policy.subagents === true ? null : 'Sub-agents are turned off for this profile.';
    case 'browser':
      return policy.browser === true ? null : 'The browser is turned off for this profile.';
    case 'computer':
      return policy.computer === true ? null : COMPUTER_OFF_REASON;
    // Generation: the tool's name says which choice it needs; an unknown name
    // under this source gets none, so it fails closed.
    case 'media':
      return mediaChoiceFor(tool.name, policy) ? null : MEDIA_OFF_REASON;
    default: {
      const exhaustive: never = tool.source;
      return `Unknown tool source: ${String(exhaustive)}`;
    }
  }
}
