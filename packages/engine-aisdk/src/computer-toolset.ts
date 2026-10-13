import type { ModelMessage, ToolResultPart } from 'ai';
import { cardLine } from '@grunt/core/domain/card-text.js';
import { isComputerAction } from '@grunt/core/domain/computer-apps.js';

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
 * see `COMPUTER_TOOLSET_CONFIGS`) becomes a line of text where it stood in the
 * assistant's message, and its result becomes a line of text in a user message
 * right after the results that stay. Text rather than nothing, so the model
 * still sees that it tried and what came back; a user message for the result
 * because results may only answer calls, a request may not end on the
 * assistant's turn, and text after the results of the same turn is what the
 * API takes. The SDK joins that user message with the tool results before it
 * and any user message after it, so roles still alternate.
 */
export function toolsetSafeMessages(messages: ModelMessage[], toolName: string): ModelMessage[] {
  /** Calls shown as text whose result has not come by yet. */
  const plain = new Set<string>();
  let changed = false;
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      let touched = false;
      const content = message.content.map((part) => {
        if (part.type !== 'tool-call' || !isToolsetCall(part, toolName)) return part;
        const action = actionOf(part.input);
        if (isComputerAction(action)) return part;
        touched = true;
        plain.add(part.toolCallId);
        return { type: 'text' as const, text: toolsetCallNote(action) };
      });
      if (touched) changed = true;
      out.push(touched ? { ...message, content } : message);
      continue;
    }
    if (message.role === 'tool') {
      const kept: typeof message.content = [];
      const notes: { type: 'text'; text: string }[] = [];
      for (const part of message.content) {
        if (part.type === 'tool-result' && plain.has(part.toolCallId)) {
          plain.delete(part.toolCallId);
          notes.push({ type: 'text', text: toolsetResultNote(part.output) });
        } else kept.push(part);
      }
      if (notes.length === 0) {
        out.push(message);
        continue;
      }
      changed = true;
      if (kept.length > 0) out.push({ ...message, content: kept });
      out.push({ role: 'user', content: notes });
      continue;
    }
    out.push(message);
  }
  return changed ? out : messages;
}

/** The longest result text a note carries. */
const RESULT_NOTE_MAX = 4000;

/** The line that stands where a call was. Only the action's name is repeated, as one clean line. */
export function toolsetCallNote(action: unknown): string {
  const why = typeof action === 'string' ? `"${cardLine(action, 40)}" is not one of its actions` : 'it named no action';
  return `[A call to the computer tool that can't be shown as one: ${why}.]`;
}

/** The line that stands for what such a call returned. */
export function toolsetResultNote(output: ToolResultPart['output']): string {
  const text = outputText(output);
  const points = Array.from(text);
  return `[What that call returned: ${points.length > RESULT_NOTE_MAX ? `${points.slice(0, RESULT_NOTE_MAX).join('')}\u2026` : text}]`;
}

/** Whether the SDK would write this call back as a member of the toolset: by the tool's name, or by what the provider said about it. */
function isToolsetCall(part: { toolName: string; providerOptions?: unknown }, toolName: string): boolean {
  if (part.toolName === toolName) return true;
  const anthropic = (part.providerOptions as { anthropic?: { toolsetName?: unknown } } | undefined)?.anthropic;
  return typeof anthropic?.toolsetName === 'string';
}

function actionOf(input: unknown): unknown {
  return typeof input === 'object' && input !== null && !Array.isArray(input) && Object.hasOwn(input, 'action') ? (input as Record<string, unknown>)['action'] : undefined;
}

/** A tool result as text: what the model would have read in the result itself, without any image. */
function outputText(output: ToolResultPart['output']): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value) ?? '';
    case 'execution-denied':
      return output.reason ?? 'Tool call execution denied.';
    case 'content':
      return output.value.map((item) => (item.type === 'text' ? item.text : '[not shown]')).join('\n');
    default:
      return '';
  }
}
