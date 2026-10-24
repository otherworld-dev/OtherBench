// Live probe (manual; needs the Claude login): does a media tool served by
// OtherBench's MCP server (the real `otherBenchMcpServer`) get Claude Code's
// tool-use id in `_meta["claudecode/toolUseId"]`, the request's abort signal,
// and does Claude see an image content block in the result?
// Needs `npm run build` first.
// Run from packages/engine-claude-code:  node test/fixtures/media-relay-probe.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { otherBenchMcpServer, OTHERBENCH_TOOL_TIMEOUT_MS } from '../../dist/otherbench-server.js';

// A 1x1 red PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const seen = [];
const hookIds = [];
const NAME = 'probe_media';
const server = otherBenchMcpServer(NAME, [
  {
    name: 'generate_image',
    description: 'Generates an image from a prompt. Returns the image.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    alwaysLoad: true,
    async call(args, opts) {
      seen.push({ args, toolUseId: opts?.toolUseId ?? null, signal: opts?.signal instanceof AbortSignal });
      return { content: [{ type: 'text', text: 'Generated 1 image.' }, { type: 'image', data: PNG, mimeType: 'image/png' }] };
    },
  },
]);

const cwd = mkdtempSync(join(tmpdir(), 'otherbench-media-probe-'));
const q = query({
  // No colour is named here, so naming the right one shows Claude saw the image's pixels.
  prompt: 'Call the generate_image tool once with prompt "a small dot". Then say in one short sentence what colour the returned image is.',
  options: {
    cwd,
    model: 'haiku',
    settingSources: [],
    strictMcpConfig: true,
    tools: [],
    mcpServers: { [NAME]: server },
    allowedTools: [`mcp__${NAME}__generate_image`],
    persistSession: false,
    maxTurns: 3,
    hooks: {
      PreToolUse: [{ hooks: [async (input) => { hookIds.push({ tool: input.tool_name, id: input.tool_use_id, agentId: input.agent_id ?? null }); return { continue: true }; }] }],
    },
  },
});

let result = null;
const assistantText = [];
try {
  for await (const msg of q) {
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') assistantText.push(b.text);
    if (msg.type === 'result') result = msg;
  }
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
const hook = hookIds.find((h) => h.tool.endsWith('generate_image'));
const hookId = hook?.id ?? null;
const metaId = seen[0]?.toolUseId ?? null;
console.log('hook tool_use_id:', hookId);
console.log('tool saw _meta id:', metaId);
console.log('ids match:', hookId !== null && hookId === metaId);
console.log("hook agent_id (the main agent's call, so none expected):", hook?.agentId ?? null);
console.log('tool saw signal:', seen[0]?.signal ?? false);
console.log('configured server timeout (ms):', server.timeout, server.timeout === OTHERBENCH_TOOL_TIMEOUT_MS ? '(6 h; whether the CLI honours it is not observable here)' : '');
console.log('assistant text:', JSON.stringify(assistantText));
console.log('result:', result?.subtype, JSON.stringify(result?.result ?? null));
// The image's colour, as a word: only the pixels say it.
const sawImage = /\bred\b/i.test(assistantText.join(' '));
console.log('Claude named the colour (red):', sawImage);
const ok = seen.length === 1 && hookId !== null && hookId === metaId && seen[0].signal && sawImage;
console.log(ok ? 'PROBE OK' : 'PROBE FAILED');
process.exit(ok ? 0 : 1);
