// Live probe (manual; needs the Claude login and `npm run build`): with
// relayed MCP tools left to tool search (not `anthropic/alwaysLoad`), does a
// clean chat still find and call the one it needs? Uses OtherBench's own
// server and relay code from dist, and the clean-chat tool list.
// Run from packages/engine-claude-code:  node test/fixtures/probe-deferred-relay.mjs [model]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { CLEAN_CHAT_AGENT_TOOLS } from '@otherbench/core/domain/agent-tools.js';
import { otherBenchMcpServer } from '../../dist/otherbench-server.js';
import { relayServerTool } from '../../dist/relay.js';

const model = process.argv[2] ?? 'sonnet';
const called = [];
// NAMES=real gives the tools names like a real server's (the answer is `tickets_list_open`); by default
// they're `collection_<n>`, where only the description says which one holds the tickets.
const real = ['calendar_list_events', 'calendar_add_event', 'contacts_search', 'contacts_get', 'deck_list_boards', 'deck_list_cards', 'deck_add_card', 'deck_move_card', 'files_list', 'files_read', 'files_upload', 'files_share', 'mail_list_inbox', 'mail_send', 'mail_search', 'notes_list', 'notes_get', 'notes_add', 'photos_list_albums', 'photos_search', 'tasks_list', 'tasks_add', 'tasks_done', 'tickets_list_open', 'tickets_get', 'tickets_comment', 'tickets_close', 'invoices_list', 'invoices_get', 'invoices_send', 'wiki_find', 'wiki_get', 'wiki_put', 'bookmarks_list', 'bookmarks_add', 'talk_list_rooms', 'talk_send', 'forms_list', 'forms_results', 'polls_list'];
const nameOf = (i) => (process.env.NAMES === 'real' ? real[i] : `collection_${i}`);
const spec = (i) => ({
  name: `mcp__records__${nameOf(i)}`,
  description: i === 23 ? 'Lists the open support tickets, newest first.' : `Lists the records in archive collection ${i}.`,
  parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
  risk: 'read',
  source: 'mcp',
  execute: async () => null,
});
// ALWAYS_LOAD=1 sends every tool up front instead, as a control.
const alwaysLoad = process.env.ALWAYS_LOAD === '1';
const tools = Array.from({ length: 40 }, (_, i) => ({
  ...relayServerTool(`records__${nameOf(i)}`, spec(i), () => async (s) => {
    called.push(s.name);
    return [{ type: 'text', text: i === 23 ? 'Ticket 881: printer on fire.' : '[]' }];
  }),
  ...(alwaysLoad ? { alwaysLoad: true } : {}),
}));

const seen = [];
let usage = null;
const q = query({
  prompt: 'What is the newest open support ticket? Use the tools you have.',
  options: {
    cwd: mkdtempSync(join(tmpdir(), 'otherbench-deferred-probe-')),
    model,
    persistSession: false,
    settingSources: [],
    strictMcpConfig: true,
    tools: ['WebSearch', 'WebFetch', ...CLEAN_CHAT_AGENT_TOOLS],
    mcpServers: { otherbench_probe: otherBenchMcpServer('otherbench_probe', tools) },
    canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
  },
});
for await (const m of q) {
  if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') seen.push(b.name);
  if (m.type === 'result') usage = m.usage;
  if (m.type === 'result') console.log('answer:', m.result);
}
console.log('tool calls:', seen.join(' -> '));
console.log('relayed calls run:', called.join(', ') || 'none');
console.log('input tokens of the last request:', (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0));
