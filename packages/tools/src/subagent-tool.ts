import { SUBAGENT_TOOL_NAME } from '@otherbench/core/domain/parts.js';
import { eligibleSubagentProfiles, runSubagentTool, SUBAGENT_TOOL_PARAMETERS, subagentToolDescription } from '@otherbench/core/domain/subagent.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { ToolPolicy } from '@otherbench/core/types/config.js';

/**
 * The `subagent` tool for API engines (spec 2026-10-12-api-subagents-design).
 * The call itself has no effect, so the broker allows it by policy (no
 * card); it is still audited, and every tool call the sub-agent makes is
 * gated on its own. Its description names the profiles it can run as, read
 * fresh each turn.
 */
export function subagentTool(store: Store, policy?: ToolPolicy): ToolSpec {
  return {
    name: SUBAGENT_TOOL_NAME,
    description: subagentToolDescription(eligibleSubagentProfiles(store), policy),
    parameters: SUBAGENT_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    risk: 'read',
    source: 'subagent',
    execute: runSubagentTool,
  };
}
