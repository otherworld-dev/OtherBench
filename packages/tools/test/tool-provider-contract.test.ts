import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import { runToolProviderContract } from '@grunt/core/testing/tool-provider-contract.js';
import { GruntToolProvider } from '../src/provider.js';
import type { McpClient } from '../src/mcp/client.js';

// The IDENTICAL shared contract (packages/core/src/testing/tool-provider-contract.ts)
// that FakeToolProvider passes, run against the real GruntToolProvider. The contract's
// MCP servers are served by a stub manager (real built-in fs/shell tools run for real).
runToolProviderContract('GruntToolProvider', ({ mcpServers }) => {
  const store = new InMemoryStore();
  return new GruntToolProvider(store, new PermissionBroker(store), {
    listFor: (ids) =>
      mcpServers
        .filter((s) => ids.includes(s.id))
        .map((s) => ({
          id: s.id,
          name: s.name,
          client: {
            id: s.id,
            status: 'ok',
            lastError: null,
            tools: s.tools.map((t) => ({ name: t.name, description: '', inputSchema: {}, readOnlyHint: t.readOnly })),
            callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
          } as unknown as McpClient,
        })),
    refresh: async () => {},
    shutdown: async () => {},
  });
});
