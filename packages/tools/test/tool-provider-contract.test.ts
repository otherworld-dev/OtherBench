import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import { runToolProviderContract } from '@grunt/core/testing/tool-provider-contract.js';
import { GruntToolProvider } from '../src/provider.js';

// The IDENTICAL shared contract (packages/core/src/testing/tool-provider-contract.ts)
// that FakeToolProvider passes, run against the real GruntToolProvider with no MCP servers.
runToolProviderContract('GruntToolProvider', () => {
  const store = new InMemoryStore();
  return new GruntToolProvider(store, new PermissionBroker(store), {
    listFor: () => [],
    refresh: async () => {},
    shutdown: async () => {},
  });
});
