import { ARTIFACT_TOOL, ARTIFACT_TOOL_DESCRIPTION, ARTIFACT_TOOL_PARAMETERS, runArtifactCommand } from '@grunt/core/domain/artifacts.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { ToolSpec } from '@grunt/core/ports/tool-provider.js';

/**
 * The `artifact` tool for API engines (Deck #896). It changes nothing outside
 * Grunt and every version is kept, so the broker allows it by policy (no
 * card); it still goes through the broker and the audit like every tool.
 */
export function artifactTool(store: Store): ToolSpec {
  return {
    name: ARTIFACT_TOOL,
    description: ARTIFACT_TOOL_DESCRIPTION,
    parameters: ARTIFACT_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    risk: 'read',
    source: 'artifact',
    execute: async (args, ctx) => runArtifactCommand(store, { chatId: ctx.chatId, messageId: ctx.messageId }, args),
  };
}
