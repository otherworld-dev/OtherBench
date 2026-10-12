import { SUBAGENT_TOOL_NAME } from '@grunt/core/domain/parts.js';
import { eligibleSubagentProfiles, runSubagentTool, SUBAGENT_TOOL_PARAMETERS, subagentToolDescription } from '@grunt/core/domain/subagent.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { ToolSpec } from '@grunt/core/ports/tool-provider.js';

/**
 * The `subagent` tool for API engines (spec 2026-10-12-api-subagents-design).
 * The call itself has no effect, so the broker allows it by policy (no
 * card); it is still audited, and every tool call the sub-agent makes is
 * gated on its own. Its description names the profiles it can run as, read
 * fresh each turn.
 */
export function subagentTool(store: Store): ToolSpec {
  return {
    name: SUBAGENT_TOOL_NAME,
    description: subagentToolDescription(eligibleSubagentProfiles(store)),
    parameters: SUBAGENT_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    risk: 'read',
    source: 'subagent',
    execute: runSubagentTool,
  };
}
