import type { Part, SubagentStatus } from '../types/messages.js';
import type { Usage } from '../types/usage.js';

/**
 * Pure folds over a message's `parts`, shared by the server (TurnRunner,
 * StreamRegistry, the peer relay) and the web client, so all of them build
 * the same parts from the same events. No Node imports: the web imports this.
 */

/** The API tool that starts a sub-agent (spec 2026-10-12-api-subagents-design). */
export const SUBAGENT_TOOL_NAME = 'subagent';

export type SubagentPart = Extract<Part, { type: 'subagent' }>;
export type SubagentEndStatus = Exclude<SubagentStatus, 'queued' | 'running'>;

/** One step in a sub-agent's life, carried on a `subagent` TurnEvent with its call id. */
export type SubagentEvent =
  | { type: 'start'; label: string; prompt: string; profileId: string; profileName: string; modelId: string }
  | { type: 'running' }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'tool-result'; id: string; name: string; result: unknown; isError: boolean }
  | { type: 'notice'; text: string }
  | { type: 'end'; status: SubagentEndStatus; error?: string; usage?: Usage };

/**
 * Appends streamed text (or reasoning) onto `parts`, merging into the
 * trailing part when it is already the same kind (the common case -- a
 * run of `text-delta` events building up one paragraph) rather than
 * fragmenting one logical span of text into one `Part` per network chunk.
 * A different kind arriving (e.g. a tool-call between two text spans, or
 * the very first delta) starts a new part instead.
 */
export function appendDelta(parts: Part[], kind: 'text' | 'reasoning', text: string): Part[] {
  const last = parts.at(-1);
  if (last && last.type === kind) {
    const merged = { ...last, text: last.text + text } as Part;
    return [...parts.slice(0, -1), merged];
  }
  return [...parts, { type: kind, text } as Part];
}

/** Folds a content event (text, reasoning, tool call or result, notice) into a sub-agent's own parts; any other event changes nothing. */
export function foldSubagentContent(parts: Part[], event: SubagentEvent): Part[] {
  switch (event.type) {
    case 'text-delta':
      return appendDelta(parts, 'text', event.text);
    case 'reasoning-delta':
      return appendDelta(parts, 'reasoning', event.text);
    case 'tool-call':
      return [...parts, { type: 'tool-call', id: event.id, name: event.name, args: event.args }];
    case 'tool-result':
      return [...parts, { type: 'tool-result', id: event.id, name: event.name, result: event.result, isError: event.isError }];
    case 'notice':
      return [...parts, { type: 'notice', text: event.text }];
    default:
      return parts;
  }
}

/**
 * Folds one sub-agent event into a reply's parts. `start` appends a queued
 * `subagent` part (once per call id); every other event updates that part,
 * and an event for an unknown call id changes nothing (returns `parts`
 * itself).
 */
export function applySubagentEvent(parts: Part[], callId: string, event: SubagentEvent): Part[] {
  const index = parts.findIndex((p) => p.type === 'subagent' && p.callId === callId);
  if (event.type === 'start') {
    if (index !== -1) return parts;
    const { label, prompt, profileId, profileName, modelId } = event;
    return [...parts, { type: 'subagent', callId, label, prompt, profileId, profileName, modelId, status: 'queued', parts: [] }];
  }
  if (index === -1) return parts;
  const part = parts[index] as SubagentPart;
  let next: SubagentPart;
  if (event.type === 'running') {
    next = { ...part, status: 'running' };
  } else if (event.type === 'end') {
    next = { ...part, status: event.status, ...(event.error !== undefined ? { error: event.error } : {}), ...(event.usage ? { usage: event.usage } : {}) };
  } else {
    next = { ...part, parts: foldSubagentContent(part.parts, event) };
  }
  return parts.with(index, next);
}

/** The events that rebuild a stored `subagent` part (StreamRegistry's fallback from the store): folding them gives the part back. */
export function subagentPartEvents(part: SubagentPart): SubagentEvent[] {
  const events: SubagentEvent[] = [
    { type: 'start', label: part.label, prompt: part.prompt, profileId: part.profileId, profileName: part.profileName, modelId: part.modelId },
  ];
  if (part.status !== 'queued') events.push({ type: 'running' });
  for (const p of part.parts) {
    switch (p.type) {
      case 'text':
        events.push({ type: 'text-delta', text: p.text });
        break;
      case 'reasoning':
        events.push({ type: 'reasoning-delta', text: p.text });
        break;
      case 'tool-call':
        events.push({ type: 'tool-call', id: p.id, name: p.name, args: p.args });
        break;
      case 'tool-result':
        events.push({ type: 'tool-result', id: p.id, name: p.name, result: p.result, isError: p.isError });
        break;
      case 'notice':
        events.push({ type: 'notice', text: p.text });
        break;
      default:
        break;
    }
  }
  if (part.status === 'complete' || part.status === 'error' || part.status === 'cancelled') {
    events.push({ type: 'end', status: part.status, ...(part.error !== undefined ? { error: part.error } : {}), ...(part.usage ? { usage: part.usage } : {}) });
  }
  return events;
}

const END_STATUSES: ReadonlySet<string> = new Set(['complete', 'error', 'cancelled']);

function isUsage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const u = value as Record<string, unknown>;
  return ['tokensIn', 'tokensOut', 'tokensCached', 'tokensReasoning'].every((k) => typeof u[k] === 'number');
}

/** Whether `value` is a well-formed `SubagentEvent`: for events that come from outside this process (a paired machine's relay). */
export function isSubagentEvent(value: unknown): value is SubagentEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  const str = (key: string): boolean => typeof e[key] === 'string';
  switch (e['type']) {
    case 'start':
      return str('label') && str('prompt') && str('profileId') && str('profileName') && str('modelId');
    case 'running':
      return true;
    case 'text-delta':
    case 'reasoning-delta':
    case 'notice':
      return str('text');
    case 'tool-call':
      return str('id') && str('name');
    case 'tool-result':
      return str('id') && str('name') && typeof e['isError'] === 'boolean';
    case 'end':
      return (
        typeof e['status'] === 'string' && END_STATUSES.has(e['status']) &&
        (e['error'] === undefined || str('error')) &&
        (e['usage'] === undefined || isUsage(e['usage']))
      );
    default:
      return false;
  }
}
