import { ARTIFACT_TOOL, ARTIFACT_TOOL_DESCRIPTION, ARTIFACT_TOOL_PARAMETERS, runArtifactCommand } from '@grunt/core/domain/artifacts.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { RiskClass, ToolSpec } from '@grunt/core/ports/tool-provider.js';

/** The MCP tools among `specs`, by namespaced name and risk: what a live declaration may name (spec 2026-10-12-live-artifacts). */
export function liveToolRisks(specs: readonly ToolSpec[]): ReadonlyMap<string, RiskClass> {
  return new Map(specs.filter((s) => s.source === 'mcp').map((s) => [s.name, s.risk] as const));
}

/**
 * The `artifact` tool for API engines (Deck #896). It changes nothing outside
 * Grunt and every version is kept, so the broker allows it by policy (no
 * card); it still goes through the broker and the audit like every tool.
 * `liveTools`, called only when a live declaration needs checking, gives the
 * profile's MCP tools.
 */
export function artifactTool(store: Store, liveTools?: () => ReadonlyMap<string, RiskClass>): ToolSpec {
  return {
    name: ARTIFACT_TOOL,
    description: ARTIFACT_TOOL_DESCRIPTION,
    parameters: ARTIFACT_TOOL_PARAMETERS as unknown as Record<string, unknown>,
    risk: 'read',
    source: 'artifact',
    execute: async (args, ctx) => runArtifactCommand(store, { chatId: ctx.chatId, messageId: ctx.messageId, ...(liveTools ? { liveTools } : {}) }, args),
  };
}
