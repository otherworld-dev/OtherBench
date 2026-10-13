import { expect } from 'vitest';

/**
 * Where tool output may be in a request, per wire format. What a tool
 * returned (a screenshot, the words with it, an error from the desktop app) is
 * content from outside: it may only ever reach a model INSIDE a tool result.
 * As text or an image of the user's turn it would read as the person's own
 * words; in the system prompt, as Grunt's; in the assistant's turn, as
 * something the model said.
 *
 * Each `zones*` function splits one outgoing request into what is inside a
 * tool result and everything else; `expectOnlyInToolResults` then looks for
 * marker strings (an injected phrase, an image's base64) in both.
 */

export interface Zones {
  /** Each tool result, serialised. */
  inside: string[];
  /** Everything that is not a tool result, serialised, with where it is. */
  outside: { where: string; text: string }[];
}

type Json = Record<string, unknown>;

const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

/** Anthropic Messages: `tool_result` blocks of a user message are inside; `system`, every other block and every assistant block are outside. */
export function zonesAnthropic(body: Json): Zones {
  const zones: Zones = { inside: [], outside: [] };
  if (body['system'] !== undefined) zones.outside.push({ where: 'system', text: JSON.stringify(body['system']) });
  list(body['messages']).forEach((message, i) => {
    if (typeof message['content'] === 'string') zones.outside.push({ where: `messages[${i}] (${String(message['role'])})`, text: message['content'] });
    list(message['content']).forEach((block, j) => {
      if (message['role'] === 'user' && block['type'] === 'tool_result') zones.inside.push(JSON.stringify(block));
      else zones.outside.push({ where: `messages[${i}].content[${j}] (${String(message['role'])} ${String(block['type'])})`, text: JSON.stringify(block) });
    });
  });
  return zones;
}

/** OpenAI Responses: `function_call_output` items are inside; `instructions` and every other input item are outside. */
export function zonesOpenAiResponses(body: Json): Zones {
  const zones: Zones = { inside: [], outside: [] };
  if (body['instructions'] !== undefined) zones.outside.push({ where: 'instructions', text: JSON.stringify(body['instructions']) });
  list(body['input']).forEach((item, i) => {
    if (item['type'] === 'function_call_output') zones.inside.push(JSON.stringify(item));
    else zones.outside.push({ where: `input[${i}] (${String(item['role'] ?? item['type'])})`, text: JSON.stringify(item) });
  });
  return zones;
}

/**
 * Google generateContent: `functionResponse` parts are inside; `systemInstruction`
 * and every other part are outside. For models before Gemini 3 the SDK writes
 * one function response per text item of a result, so the parts that answer
 * one call (the same `id`) are read together as its one result.
 */
export function zonesGoogle(body: Json): Zones {
  const zones: Zones = { inside: [], outside: [] };
  if (body['systemInstruction'] !== undefined) zones.outside.push({ where: 'systemInstruction', text: JSON.stringify(body['systemInstruction']) });
  list(body['contents']).forEach((content, i) => {
    const byCall = new Map<string, string[]>();
    list(content['parts']).forEach((part, j) => {
      const response = part['functionResponse'] as Json | undefined;
      if (response !== undefined && Object.keys(part).length === 1) {
        const id = typeof response['id'] === 'string' ? response['id'] : `part-${j}`;
        byCall.set(id, [...(byCall.get(id) ?? []), JSON.stringify(part)]);
      } else zones.outside.push({ where: `contents[${i}].parts[${j}] (${String(content['role'])} ${Object.keys(part).join('+')})`, text: JSON.stringify(part) });
    });
    for (const parts of byCall.values()) zones.inside.push(parts.join('\n'));
  });
  return zones;
}

/** Chat completions (openai-compatible, Ollama): `role: tool` messages are inside; every other message is outside. */
export function zonesChat(body: Json): Zones {
  const zones: Zones = { inside: [], outside: [] };
  list(body['messages']).forEach((message, i) => {
    if (message['role'] === 'tool') zones.inside.push(JSON.stringify(message));
    else zones.outside.push({ where: `messages[${i}] (${String(message['role'])})`, text: JSON.stringify(message) });
  });
  return zones;
}

/** The AI SDK's own prompt, as a provider is handed it: `tool-result` parts of `role: tool` messages are inside; everything else is outside. */
export function zonesSdkPrompt(prompt: unknown): Zones {
  const zones: Zones = { inside: [], outside: [] };
  list(prompt).forEach((message, i) => {
    if (typeof message['content'] === 'string') zones.outside.push({ where: `prompt[${i}] (${String(message['role'])})`, text: message['content'] });
    list(message['content']).forEach((part, j) => {
      if (message['role'] === 'tool' && part['type'] === 'tool-result') zones.inside.push(JSON.stringify(part));
      else zones.outside.push({ where: `prompt[${i}].content[${j}] (${String(message['role'])} ${String(part['type'])})`, text: JSON.stringify(part) });
    });
  });
  return zones;
}

/** A marker as it reads inside serialised JSON (a quote or a backslash in it is escaped there). */
const serialised = (marker: string): string => JSON.stringify(marker).slice(1, -1);

/**
 * Fails when any marker is anywhere but inside a tool result. `present` are
 * the markers that must be there (inside a tool result) at least once, so the
 * check can't pass because the output never went out at all; `after`, when
 * given, is a line every tool result holding a marker must carry before it.
 */
export function expectOnlyInToolResults(zones: Zones, markers: string[], opts: { present?: string[]; absent?: string[]; after?: string } = {}): void {
  for (const marker of markers) {
    const needle = serialised(marker);
    const leaks = zones.outside.filter((zone) => zone.text.includes(needle)).map((zone) => zone.where);
    expect(leaks, `"${marker.slice(0, 40)}" outside a tool result`).toEqual([]);
  }
  for (const marker of opts.present ?? markers) {
    expect(zones.inside.some((text) => text.includes(serialised(marker))), `"${marker.slice(0, 40)}" inside a tool result`).toBe(true);
  }
  for (const marker of opts.absent ?? []) {
    expect(zones.inside.some((text) => text.includes(serialised(marker))), `"${marker.slice(0, 40)}" is not sent at all`).toBe(false);
  }
  if (opts.after !== undefined) {
    const line = serialised(opts.after);
    for (const text of zones.inside) {
      for (const marker of markers) {
        const at = text.indexOf(serialised(marker));
        if (at === -1) continue;
        const lineAt = text.indexOf(line);
        expect(lineAt !== -1 && lineAt < at, `the line comes before "${marker.slice(0, 40)}" in its tool result`).toBe(true);
      }
    }
  }
}
