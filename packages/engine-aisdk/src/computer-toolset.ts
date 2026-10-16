import type { ModelMessage } from 'ai';
import { isComputerAction } from '@otherbench/core/domain/computer-apps.js';

/**
 * Messages made safe to send with Anthropic's computer toolset among the
 * tools (spec 2026-10-12-computer-use-design section 5).
 *
 * With the toolset on, the SDK writes every tool call named for it back to the
 * API as a member call: `tool_use` with `name: <args.action>` and
 * `toolset_name`. A call whose `action` is not text is dropped there, while
 * its `tool_result` is still written; one whose `action` is some other word
 * goes out as a member the toolset does not have, or one that is turned off.
 * The Messages API refuses a result without its call (and may refuse a member
 * it does not know), so the turn fails, and the chat stays broken for as long
 * as that call is in its history.
 *
 * Such calls come from two places: a chat whose earlier replies used the JSON
 * tool (another model, broken input) and a member call in this very reply
 * whose input was not what the toolset's schema allows. So this runs on the
 * messages a request starts with AND on those of every later step.
 *
 * What it does: a call of the toolset whose `action` is not one of core's
 * phase-1 actions (which are exactly the toolset's members that are turned on,
 * see `COMPUTER_TOOLSET_CONFIGS`) stays a call, and its result stays the result
 * of that call, under a name the toolset does not claim
 * (`TOOLSET_PLAIN_CALL`): the SDK then writes the pair as an ordinary
 * `tool_use` and `tool_result`. Nothing moves and nothing becomes text.
 *
 * That is deliberate. What a tool returned (a screenshot, the words with it,
 * an error from the desktop app) is content from the screen, which whoever
 * wrote the page or the document on it can choose. It may only ever reach the
 * model as a tool result. Text of the user's turn, or of the assistant's own,
 * would read as an instruction from the person or as something the model said.
 */
export function toolsetSafeMessages(messages: ModelMessage[], toolName: string): ModelMessage[] {
  /** Calls written under the plain name whose result has not come by yet. */
  const plain = new Set<string>();
  let changed = false;
  const out = messages.map((message): ModelMessage => {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      let touched = false;
      const content = message.content.map((part) => {
        if (part.type !== 'tool-call' || !isToolsetCall(part, toolName) || isComputerAction(actionOf(part.input))) return part;
        touched = true;
        plain.add(part.toolCallId);
        // Only the id, the name and the arguments: nothing the provider said about the call (its toolset) comes along.
        return { type: 'tool-call' as const, toolCallId: part.toolCallId, toolName: TOOLSET_PLAIN_CALL, input: isRecord(part.input) ? part.input : {} };
      });
      if (!touched) return message;
      changed = true;
      return { ...message, content };
    }
    if (message.role === 'tool') {
      let touched = false;
      const content = message.content.map((part) => {
        if (part.type !== 'tool-result' || !plain.has(part.toolCallId)) return part;
        touched = true;
        plain.delete(part.toolCallId);
        return { type: 'tool-result' as const, toolCallId: part.toolCallId, toolName: TOOLSET_PLAIN_CALL, output: part.output };
      });
      if (!touched) return message;
      changed = true;
      return { ...message, content };
    }
    return message;
  });
  return changed ? out : messages;
}

/**
 * The name a `computer` call is written under when the toolset has no member
 * for it. It is in no request's tools, so the model cannot call it; a call and
 * its result under it are history, as those of any tool a profile no longer
 * has.
 */
export const TOOLSET_PLAIN_CALL = 'invalid_computer_call';

/** Whether the SDK would write this call back as a member of the toolset: by the tool's name, or by what the provider said about it. */
function isToolsetCall(part: { toolName: string; providerOptions?: unknown }, toolName: string): boolean {
  if (part.toolName === toolName) return true;
  const anthropic = (part.providerOptions as { anthropic?: { toolsetName?: unknown } } | undefined)?.anthropic;
  return typeof anthropic?.toolsetName === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function actionOf(input: unknown): unknown {
  return isRecord(input) && Object.hasOwn(input, 'action') ? input['action'] : undefined;
}
