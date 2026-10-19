// Live probe (manual; needs the Claude login, spends a little plan usage):
// what one short Claude Code turn costs in input tokens under the options
// OtherBench starts processes with, and what relaying MCP tools adds to it,
// loaded up front (`anthropic/alwaysLoad`) or left to tool search.
// Run from packages/engine-claude-code:  node test/fixtures/probe-token-cost.mjs [model] [workspace]
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const model = process.argv[2] ?? 'sonnet';
const workspace = process.argv[3] ?? process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'otherbench-cost-probe-'));

/** An in-process server with `count` tools shaped like a real MCP server's (a paragraph of description, a few typed fields). */
function relayServer(count, alwaysLoad) {
  const instance = new McpServer({ name: 'relay', version: '1.0.0' }, { capabilities: { tools: {} } });
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from({ length: count }, (_, i) => ({
      name: `records_tool_${i}`,
      description: `Tool ${i} of a records service. Lists, filters or updates records in collection ${i}. Use it when the user asks about collection ${i}; pass a filter to narrow the results, and a limit to page through them. Returns JSON with the matching records and a cursor for the next page.`,
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'A filter expression, e.g. status:open.' },
          limit: { type: 'integer', description: 'How many records to return, 1-100.' },
          cursor: { type: 'string', description: 'The cursor from a previous page.' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Which fields to include.' },
        },
      },
      ...(alwaysLoad ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: '[]' }] }));
  return { type: 'sdk', name: 'relay', instance };
}

const deny = async () => ({ behavior: 'deny', message: 'probe' });
const base = { model, maxTurns: 1, persistSession: false, permissionMode: 'default', canUseTool: deny };
const workspaceOpts = (sources) => ({ ...base, cwd: workspace, settingSources: sources, systemPrompt: { type: 'preset', preset: 'claude_code' } });
const cleanOpts = (extra = {}) => ({ ...base, cwd: scratch, settingSources: [], strictMcpConfig: true, tools: ['WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion'], ...extra });

const runs = [
  ['workspace, user+project+local settings (as now)', workspaceOpts(['user', 'project', 'local'])],
  ['workspace, project+local settings only', workspaceOpts(['project', 'local'])],
  ['clean chat', cleanOpts()],
  ['clean chat + 40 relayed tools, alwaysLoad', cleanOpts({ mcpServers: { relay: relayServer(40, true) } })],
  ['clean chat + 40 relayed tools, deferred + ToolSearch', cleanOpts({ mcpServers: { relay: relayServer(40, false) }, tools: ['WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion', 'ToolSearch'] })],
];

for (const [label, options] of runs) {
  let tools = [];
  let usage = null;
  try {
    for await (const m of query({ prompt: 'Reply with exactly: OK', options })) {
      if (m.type === 'system' && m.subtype === 'init') tools = m.tools;
      if (m.type === 'result') usage = m.usage;
    }
  } catch (err) {
    console.log(`${label}: failed: ${err instanceof Error ? err.message : err}`);
    continue;
  }
  const u = usage ?? {};
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const relayed = tools.filter((t) => t.startsWith('mcp__relay__')).length;
  console.log(`${label}\n  input ${input} (uncached ${u.input_tokens ?? 0}, cache write ${u.cache_creation_input_tokens ?? 0}, cache read ${u.cache_read_input_tokens ?? 0}); ${tools.length} tools in init (${relayed} relayed)`);
}
