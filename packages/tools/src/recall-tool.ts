import { RECALL_TOOL, RECALL_TOOL_DESCRIPTION, RECALL_TOOL_PARAMETERS, runRecallCommand } from '@otherbench/core/domain/recall.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { ToolSpec } from '@otherbench/core/ports/tool-provider.js';

/**
 * The `recall` tool for API engines (spec 2026-10-09-recall-design). It only
 * reads OtherBench's own chats and projects, so the broker allows it by policy (no
 * card); it still goes through the broker and the audit like every tool.
 */
export function recallTool(store: Store): ToolSpec {
  return {
    name: RECALL_TOOL,
    description: RECALL_TOOL_DESCRIPTION,
    parameters: RECALL_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    risk: 'read',
    source: 'recall',
    execute: async (args, ctx) => runRecallCommand(store, { chatId: ctx.chatId }, args),
  };
}
