/**
 * The line an approval card shows for a call (`ApprovalRequest.summary`),
 * built by the permission broker (`../permissions.ts`) when `decide()` asks.
 * What a person approves is what this says, so each source's line names the
 * thing its grant would be pinned to (the command, the host, the app's key)
 * from validated values only, and never typed text.
 */
import { cardLine } from '../card-text.js';
import { actionSummary, describeApp } from '../computer-apps.js';
import { canonicalHost } from '../network-hosts.js';
import type { ToolSpec } from '../../ports/tool-provider.js';
import type { Store } from '../../ports/store.js';
import { rawField, stringField } from './fields.js';

/** The card's line for a call `decide()` is asking about. */
export function cardSummary(store: Store, tool: ToolSpec, args: unknown): string {
  return tool.source === 'recall'
    ? recallSummary(store, args)
    : tool.source === 'network'
      ? networkSummary(args)
      : tool.source === 'browser'
        ? browserSummary(args)
        : tool.source === 'computer'
          ? computerSummary(args)
          : tool.source === 'chats'
            ? chatsSummary(store, args)
            : summarize(tool, args);
}

/**
 * A `message_chats` card's line (spec 2026-11-06-chat-to-chat-design). It asks
 * once per chat, so it says what the answer allows from then on, then this
 * call's targets by what the store calls them: a chat's title, an app's name
 * (only when an app has it), never the model's own words.
 */
function chatsSummary(store: Store, args: unknown): string {
  if (stringField(args, 'command') !== 'send') return 'Let this chat send work to other chats (now: list the chats it could send to)';
  const messages = rawField(args, 'messages');
  const list = Array.isArray(messages) ? messages : [];
  const apps = store.apps.list();
  const names = list.map((m) => {
    const chatId = stringField(m, 'chatId');
    if (chatId !== null) return store.chats.get(chatId)?.title ?? 'an unknown chat';
    const app = stringField(m, 'app');
    const match = app === null ? undefined : apps.find((a) => a.name.trim().toLowerCase() === app.trim().toLowerCase());
    return match ? `a new chat in ${match.name}` : 'an unknown app';
  });
  const count = list.length === 1 ? '1 other chat' : `${list.length} other chats`;
  return cardLine(`Let this chat send work to other chats (now: ${count}${names.length > 0 ? `: ${names.join(', ')}` : ''})`, 200);
}

/** What a recall call will look at, for its card: the query, or the chat's title, or the project. */
function recallSummary(store: Store, args: unknown): string {
  const command = stringField(args, 'command');
  const chatId = stringField(args, 'chatId');
  const project = stringField(args, 'project');
  if (command === 'search') return `Search past chats for "${stringField(args, 'query') ?? ''}"`;
  if (command === 'read' && chatId !== null) {
    const title = store.chats.get(chatId)?.title;
    return title !== undefined ? `Read the chat "${title}"` : `Read a chat (${chatId})`;
  }
  if (command === 'read' && project !== null) return `Read the project "${project}"`;
  return `recall: ${command ?? '?'}`;
}

/**
 * A computer card's line: `Use EXCEL.EXE: click at 512, 300`. The name is the
 * file name in the app's key (`describeApp`), the same key a grant would be
 * pinned to and the shell checks before acting; a name the call carries
 * (`appName`) or a window title is never used. The rest holds validated
 * values only, and never typed text (`actionSummary`).
 */
function computerSummary(args: unknown): string {
  const name = describeApp(rawField(args, 'app'))?.name;
  return `Use ${name === undefined ? '?' : cardLine(name, 80)}: ${actionSummary(args)}`;
}

/** A network card's summary: the canonical host, and its port when known. */
function networkSummary(args: unknown): string {
  const host = canonicalHost(stringField(args, 'host')) ?? '?';
  const port = typeof args === 'object' && args !== null ? (args as Record<string, unknown>)['port'] : undefined;
  return `sandbox_network: ${host}${typeof port === 'number' ? `:${port}` : ''}`;
}

/** A browser card's line: `Use <host>: <what the call does>`. */
function browserSummary(args: unknown): string {
  const host = stringField(args, 'host') ?? '?';
  const ref = stringField(args, 'ref');
  const target = stringField(args, 'target');
  const on = ref !== null ? ` ${ref}${target !== null ? ` (${target})` : ''}` : '';
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  switch (stringField(args, 'command')) {
    case 'open':
      return `Use ${host}: open ${stringField(args, 'url') ?? ''}`;
    case 'click':
      return `Use ${host}: ${record['double'] === true ? 'double-click' : 'click'}${on}`;
    case 'type':
      return `Use ${host}: type into${on}`;
    case 'select': {
      const values = Array.isArray(record['values']) ? record['values'].filter((v): v is string => typeof v === 'string').join(', ') : '';
      return `Use ${host}: choose ${values} in${on}`;
    }
    case 'press':
      return `Use ${host}: press ${stringField(args, 'key') ?? ''}`;
    case 'scroll':
      return `Use ${host}: scroll ${stringField(args, 'direction') ?? 'down'}${ref !== null ? ` to${on}` : ''}`;
    case 'back':
      return `Use ${host}: go back`;
    case 'snapshot': {
      const part = record['part'];
      return typeof part === 'number' && Number.isSafeInteger(part) && part > 1 ? `Use ${host}: read part ${part} of the page` : `Use ${host}: read the page`;
    }
    case 'close':
      return `Use ${host}: close the browser`;
    default:
      return `Use ${host}: ${stringField(args, 'command') ?? '?'}`;
  }
}

function summarize(tool: ToolSpec, args: unknown): string {
  const path = stringField(args, 'path');
  if (path !== null) return `${tool.name}(${path})`;
  const command = stringField(args, 'command');
  if (command !== null) return `${tool.name}: ${command}`;
  return tool.name;
}
