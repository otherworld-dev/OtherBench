// Live probe (manual; needs the Claude login): does Claude Code use a tool
// served by an in-process MCP server built from raw `tools/list` and
// `tools/call` handlers (a JSON input schema, no zod), under clean-chat
// options (no settings sources, strict MCP config, no built-in tools)?
// Run from packages/engine-claude-code:  node test/fixtures/raw-server-probe.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const calls = [];
const instance = new McpServer({ name: 'probe', version: '1.0.0' }, { capabilities: { tools: {} } });
instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo_raw',
      description: 'Echoes the given text back, uppercased, with a -RAW suffix.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] },
      _meta: { 'anthropic/alwaysLoad': true },
    },
  ],
}));
instance.server.setRequestHandler(CallToolRequestSchema, async (req) => {
  calls.push(req.params);
  const text = String(req.params.arguments?.text ?? '');
  return { content: [{ type: 'text', text: `${text.toUpperCase()}-RAW` }] };
});

const cwd = mkdtempSync(join(tmpdir(), 'otherbench-raw-probe-'));
const q = query({
  prompt: "Call the echo_raw tool with text 'ping', then reply with exactly what it returned and nothing else.",
  options: {
    cwd,
    model: 'haiku',
    settingSources: [],
    strictMcpConfig: true,
    tools: [],
    mcpServers: { probe: { type: 'sdk', name: 'probe', instance } },
    allowedTools: ['mcp__probe__echo_raw'],
    persistSession: false,
    maxTurns: 4,
  },
});

let result = null;
let initTools = null;
for await (const msg of q) {
  if (msg.type === 'system' && msg.subtype === 'init') initTools = msg.tools;
  if (msg.type === 'result') result = msg;
}
console.log('init tools:', JSON.stringify(initTools));
console.log('tool calls:', JSON.stringify(calls));
console.log('result:', result?.subtype, JSON.stringify(result?.result ?? null));
const ok = calls.length > 0 && typeof result?.result === 'string' && result.result.includes('PING-RAW');
console.log(ok ? 'PROBE OK' : 'PROBE FAILED');
process.exit(ok ? 0 : 1);
