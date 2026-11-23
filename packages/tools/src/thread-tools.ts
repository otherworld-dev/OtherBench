import {
  ASK_TOOL,
  ASK_TOOL_DESCRIPTION,
  ASK_TOOL_PARAMETERS,
  PLAN_TOOL,
  PLAN_TOOL_DESCRIPTION,
  PLAN_TOOL_PARAMETERS,
  TODO_TOOL,
  TODO_TOOL_DESCRIPTION,
  TODO_TOOL_PARAMETERS,
  runAskCommand,
  runPlanCommand,
  runTodoCommand,
  type AskFn,
} from '@otherbench/core/domain/thread-tools.js';
import { CHAT_STATUS_OFFERED, runStatusCommand, STATUS_TOOL, STATUS_TOOL_DESCRIPTION, STATUS_TOOL_PARAMETERS } from '@otherbench/core/domain/chat-status-tool.js';
import type { ToolSpec } from '@otherbench/core/ports/tool-provider.js';

// Thread tools for API engines (spec 2026-10-12-thread-cards-design §5).
// Source `thread`: the broker allows them by policy, and they go through the
// gate and the audit like every tool.

export function todoTool(): ToolSpec {
  return { name: TODO_TOOL, description: TODO_TOOL_DESCRIPTION, parameters: TODO_TOOL_PARAMETERS, risk: 'read', source: 'thread', execute: async (args) => runTodoCommand(args) };
}

export function askTool(askUser: AskFn): ToolSpec {
  return { name: ASK_TOOL, description: ASK_TOOL_DESCRIPTION, parameters: ASK_TOOL_PARAMETERS, risk: 'read', source: 'thread', execute: (args, ctx) => runAskCommand(askUser, ctx, args) };
}

export function planTool(askUser: AskFn): ToolSpec {
  return { name: PLAN_TOOL, description: PLAN_TOOL_DESCRIPTION, parameters: PLAN_TOOL_PARAMETERS, risk: 'read', source: 'thread', execute: (args, ctx) => runPlanCommand(askUser, ctx, args) };
}

/** `set_chat_status` (spec 2026-11-15-chat-done-status-design): stores nothing; the row reads the call from the reply. */
export function statusTool(): ToolSpec {
  return { name: STATUS_TOOL, description: STATUS_TOOL_DESCRIPTION, parameters: STATUS_TOOL_PARAMETERS, risk: 'read', source: 'thread', execute: async (args) => runStatusCommand(args) };
}

export function threadTools(askUser: AskFn): ToolSpec[] {
  return [todoTool(), askTool(askUser), planTool(askUser), ...(CHAT_STATUS_OFFERED ? [statusTool()] : [])];
}
