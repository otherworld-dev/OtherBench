#!/usr/bin/env node
// In-repo stdio MCP fixture for live artifacts (spec 2026-10-12-live-artifacts).
// echo-server.js stays unchanged because tests assert its exact tool list.
//
//   - "lookup" (readOnlyHint): returns { key, value: "value-of-<key>", n } as
//     JSON text and as structuredContent; n counts lookups in this process, so
//     a test can tell a fresh call from a cached one.
//   - "set_value" (no hints): Grunt treats it as able to change things.
//   - "wait" (readOnlyHint): sleeps `ms` milliseconds, for timeouts.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

let n = 0;
const server = new McpServer({ name: 'grunt-live-fixture', version: '1.0.0' });

server.registerTool(
  'lookup',
  {
    title: 'Lookup',
    description: 'Looks up the value for a key. Read-only.',
    inputSchema: { key: z.string() },
    outputSchema: { key: z.string(), value: z.string(), n: z.number() },
    annotations: { readOnlyHint: true },
  },
  async ({ key }) => {
    n += 1;
    const structuredContent = { key, value: `value-of-${key}`, n };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  }
);

server.registerTool(
  'set_value',
  {
    title: 'Set value',
    description: 'Sets a value. Declares no hints, so Grunt treats it as able to change things.',
    inputSchema: { key: z.string(), value: z.string() },
  },
  async ({ key, value }) => ({ content: [{ type: 'text', text: `set ${key}=${value}` }] })
);

server.registerTool(
  'wait',
  {
    title: 'Wait',
    description: 'Waits ms milliseconds, then answers. Read-only.',
    inputSchema: { ms: z.number() },
    annotations: { readOnlyHint: true },
  },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { content: [{ type: 'text', text: `waited ${ms}` }] };
  }
);

await server.connect(new StdioServerTransport());
