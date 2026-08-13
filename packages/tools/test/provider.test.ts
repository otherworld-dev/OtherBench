import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ApprovalRequest, ToolApprovalEvent, ToolContext } from '@grunt/core/ports/tool-provider.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import { GruntToolProvider } from '../src/provider.js';
import type { McpClient } from '../src/mcp/client.js';
import type { McpServerManager } from '../src/mcp/manager.js';

let ws: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    chatId: 'chat-1',
    messageId: 'msg-1',
    profileId: 'profile-1',
    workspaceRoot: ws,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate', ...overrides };
}

/** An `McpServerManager` stand-in that hands back canned tool descriptors -- used only by the collision-suffixing test below, which needs two "servers" whose tools collide after namespacing. */
function fakeMcpManager(
  servers: { id: string; name: string; tools: { name: string }[] }[]
): Pick<McpServerManager, 'listFor' | 'refresh' | 'shutdown'> {
  return {
    listFor: (serverIds) =>
      servers
        .filter((s) => serverIds.includes(s.id))
        .map((s) => ({
          id: s.id,
          name: s.name,
          client: {
            id: s.id,
            status: 'ok',
            lastError: null,
            tools: s.tools.map((t) => ({ name: t.name, description: '', inputSchema: {} })),
            onStatusChange: () => () => {},
            connect: async () => {},
            disconnect: async () => {},
            refresh: async () => {},
            callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
          } as unknown as McpClient,
        })),
    refresh: async () => {},
    shutdown: async () => {},
  };
}

const emptyMcp: Pick<McpServerManager, 'listFor' | 'refresh' | 'shutdown'> = {
  listFor: () => [],
  refresh: async () => {},
  shutdown: async () => {},
};

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-provider-test-'));
});

afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function makeProvider(): { provider: GruntToolProvider; store: InMemoryStore; broker: PermissionBroker } {
  const store = new InMemoryStore();
  const broker = new PermissionBroker(store);
  const provider = new GruntToolProvider(store, broker, emptyMcp);
  return { provider, store, broker };
}

describe('GruntToolProvider.listTools', () => {
  it('includes fs tools when policy.fs is not off, excludes them when off', async () => {
    const { provider } = makeProvider();
    const withFs = await provider.listTools(policy({ fs: 'readwrite' }));
    expect(withFs.some((t) => t.name === 'write_file')).toBe(true);

    const withoutFs = await provider.listTools(policy({ fs: 'off' }));
    expect(withoutFs.some((t) => t.name === 'write_file')).toBe(false);
  });

  it('includes the shell tool only when policy.shell is true', async () => {
    const { provider } = makeProvider();
    expect((await provider.listTools(policy({ shell: true }))).some((t) => t.name === 'run_command')).toBe(true);
    expect((await provider.listTools(policy({ shell: false }))).some((t) => t.name === 'run_command')).toBe(false);
  });

  it('stamps every MCP tool with the id of the server it came from', async () => {
    // PermissionBroker checks this against ToolPolicy.mcpServerIds. Without
    // it the policy gate could only verify that SOME server was enabled, so
    // a tool from a server the user never enabled was allowed (and, being
    // read-risk, auto-approved) on the strength of an unrelated one.
    const store = new InMemoryStore();
    const broker = new PermissionBroker(store);
    const mcp = fakeMcpManager([
      { id: 'srv-1', name: 'One', tools: [{ name: 'search' }] },
      { id: 'srv-2', name: 'Two', tools: [{ name: 'search' }] },
    ]);
    const provider = new GruntToolProvider(store, broker, mcp);
    const tools = await provider.listTools(policy({ mcpServerIds: ['srv-1', 'srv-2'] }));

    expect(tools.find((t) => t.name === 'mcp__One__search')?.serverId).toBe('srv-1');
    expect(tools.find((t) => t.name === 'mcp__Two__search')?.serverId).toBe('srv-2');
    // Built-ins have no server, and must not accidentally claim one.
    expect(tools.find((t) => t.name === 'read_file')?.serverId).toBeUndefined();
    expect(tools.find((t) => t.name === 'run_command')?.serverId).toBeUndefined();
  });

  it('namespaces MCP tools as mcp__<server>__<tool>', async () => {
    const store = new InMemoryStore();
    const broker = new PermissionBroker(store);
    const mcp = fakeMcpManager([{ id: 'srv-1', name: 'My Server', tools: [{ name: 'search' }] }]);
    const provider = new GruntToolProvider(store, broker, mcp);
    const tools = await provider.listTools(policy({ mcpServerIds: ['srv-1'] }));
    expect(tools.map((t) => t.name)).toContain('mcp__My_Server__search');
  });

  it('suffixes a genuine name collision deterministically and logs it, never handing back two tools under one name', async () => {
    const store = new InMemoryStore();
    const broker = new PermissionBroker(store);
    // Two servers that sanitize to the identical name, each exposing a tool
    // of the same name -- namespacing alone does not disambiguate this.
    const mcp = fakeMcpManager([
      { id: 'srv-1', name: 'Foo!', tools: [{ name: 'search' }] },
      { id: 'srv-2', name: 'Foo?', tools: [{ name: 'search' }] },
    ]);
    const provider = new GruntToolProvider(store, broker, mcp);
    const tools = await provider.listTools(policy({ mcpServerIds: ['srv-1', 'srv-2'] }));
    const names = tools.map((t) => t.name);
    expect(names.filter((n) => n === 'mcp__Foo___search')).toHaveLength(1);
    expect(names).toContain('mcp__Foo___search_2');
    expect(new Set(names).size).toBe(names.length); // no duplicate names survive, at all
  });
});

describe('GruntToolProvider gating', () => {
  it('fs:"off" and fs:"read" both keep write_file out of the returned tool list entirely', async () => {
    const { provider } = makeProvider();
    expect((await provider.listTools(policy({ fs: 'off' }))).some((t) => t.name === 'write_file')).toBe(false);
    const readOnly = await provider.listTools(policy({ fs: 'read' }));
    expect(readOnly.some((t) => t.name === 'write_file')).toBe(false);
    expect(readOnly.some((t) => t.name === 'read_file')).toBe(true); // read-risk fs tools stay available
  });

  it('a call denied by the broker (no workspace root configured) never reaches the underlying tool and is audited as a denial', async () => {
    const { provider, store } = makeProvider();
    const tools = await provider.listTools(policy());
    const writeFile = tools.find((t) => t.name === 'write_file')!;
    const target = join(ws, 'never-written.txt');

    const result = (await writeFile.execute({ path: 'never-written.txt', content: 'x' }, ctx({ workspaceRoot: null }))) as Record<
      string,
      unknown
    >;
    expect(result.error).toBe(true);
    expect(existsSync(target)).toBe(false);

    const audit = store.audit.list('chat-1');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ toolName: 'write_file', grantedBy: 'deny:policy' });
  });

  it('a policy-allowed read auto-approves with no approval event, runs the real tool, and writes an audit row', async () => {
    const { provider, store } = makeProvider();
    const events: ToolApprovalEvent[] = [];
    provider.onApprovalEvent((e) => events.push(e));

    const tools = await provider.listTools(policy());
    const listDir = tools.find((t) => t.name === 'list_dir')!;
    const result = (await listDir.execute({}, ctx())) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(events).toHaveLength(0);
    const audit = store.audit.list('chat-1');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ toolName: 'list_dir', grantedBy: 'auto_read' });
  });

  it('a mutating call asks, blocks until resolved, then runs the real tool once approved (once)', async () => {
    const { provider, store } = makeProvider();
    const requests: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request);
    });

    const tools = await provider.listTools(policy());
    const writeFile = tools.find((t) => t.name === 'write_file')!;
    const target = join(ws, 'note.txt');

    let settled = false;
    const promise = writeFile.execute({ path: 'note.txt', content: 'secret-body' }, ctx()).then((r) => {
      settled = true;
      return r;
    });

    // Give the microtask queue a beat -- the gate's decide()+notify() runs
    // synchronously before the await, so the request should already exist.
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    expect(settled).toBe(false); // still suspended -- nobody has answered yet
    expect(existsSync(target)).toBe(false); // and the real fs write has NOT happened yet

    const ok = provider.resolveApproval(requests[0]!.id, { choice: 'once' });
    expect(ok).toBe(true);

    const result = (await promise) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(existsSync(target)).toBe(true);

    const audit = store.audit.list('chat-1');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.grantedBy).toBe('ask:once');
    // Redaction: the file's actual content must never appear verbatim in the audit row.
    expect(JSON.stringify(audit[0]!.argsRedacted)).not.toContain('secret-body');
    expect(JSON.stringify(audit[0]!.argsRedacted)).toContain('[redacted]');

    // A second identical call is asked about again -- 'once' authorised exactly one call.
    const secondRequests: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') secondRequests.push(e.request);
    });
    void writeFile.execute({ path: 'note.txt', content: 'again' }, ctx());
    await Promise.resolve();
    await Promise.resolve();
    expect(secondRequests).toHaveLength(1);
  });

  it('a denied call returns a structured tool error, never runs the real tool, and is audited as a user denial', async () => {
    const { provider, store } = makeProvider();
    const requests: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request);
    });

    const tools = await provider.listTools(policy());
    const writeFile = tools.find((t) => t.name === 'write_file')!;
    const target = join(ws, 'denied.txt');

    const promise = writeFile.execute({ path: 'denied.txt', content: 'x' }, ctx());
    await Promise.resolve();
    await Promise.resolve();
    provider.resolveApproval(requests[0]!.id, { choice: 'deny' });

    const result = (await promise) as Record<string, unknown>;
    expect(result.error).toBe(true);
    expect(result.code).toBe('approval_denied');
    expect(existsSync(target)).toBe(false);

    const audit = store.audit.list('chat-1');
    expect(audit[0]!.grantedBy).toBe('deny:user');
  });

  it("an 'always' grant survives to a later call, and revoking it (deleting the Grant row) takes effect on the VERY NEXT call -- no restart required", async () => {
    const { provider, store } = makeProvider();
    const tools = await provider.listTools(policy());
    const writeFile = tools.find((t) => t.name === 'write_file')!;

    const requests: ApprovalRequest[] = [];
    const unsub = provider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request);
    });

    // All three calls share the "sub" path SEGMENT prefix (pathPrefix
    // matching is segment-based, not a raw string prefix -- see
    // permissions.ts's pathPrefixMatches -- so sibling filenames like
    // "g.txt"/"g2.txt" would NOT share a prefix relationship with each
    // other; nesting them under a common directory does).
    const first = writeFile.execute({ path: 'sub/g.txt', content: 'v1' }, ctx());
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    provider.resolveApproval(requests[0]!.id, { choice: 'always', constraint: { pathPrefix: 'sub' } });
    await first;

    const grants = store.grants.list();
    expect(grants).toHaveLength(1);

    // Second call: the always-grant should authorise it with NO new approval-request.
    requests.length = 0;
    const second = (await writeFile.execute({ path: 'sub/g2.txt', content: 'v2' }, ctx())) as Record<string, unknown>;
    expect(second.error).toBeUndefined();
    expect(requests).toHaveLength(0);

    // Revoke: delete the grant directly (this is exactly what the Inspector's revoke action does server-side).
    store.grants.delete(grants[0]!.id);

    // Third call, same provider instance, no restart: must ask again.
    const third = writeFile.execute({ path: 'sub/g3.txt', content: 'v3' }, ctx());
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    provider.resolveApproval(requests[0]!.id, { choice: 'deny' });
    await third;
    unsub();
  });

  it('an approval request raised by one compare-turn VARIANT does not block a sibling variant', async () => {
    const { provider } = makeProvider();
    const tools = await provider.listTools(policy());
    const writeFile = tools.find((t) => t.name === 'write_file')!;

    const requests: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request);
    });

    // Two variants of the same compare turn: same chat, DIFFERENT messageId
    // (exactly what TurnRunner gives each variant's ToolContext).
    let aSettled = false;
    let bSettled = false;
    const a = writeFile.execute({ path: 'a.txt', content: 'from-a' }, ctx({ messageId: 'variant-a' })).then((r) => {
      aSettled = true;
      return r;
    });
    const b = writeFile.execute({ path: 'b.txt', content: 'from-b' }, ctx({ messageId: 'variant-b' })).then((r) => {
      bSettled = true;
      return r;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(2);
    const forA = requests.find((r) => r.messageId === 'variant-a')!;
    const forB = requests.find((r) => r.messageId === 'variant-b')!;
    expect(forA.id).not.toBe(forB.id);

    // Approve ONLY variant A's request.
    provider.resolveApproval(forA.id, { choice: 'once' });
    await a;
    expect(aSettled).toBe(true);
    expect(bSettled).toBe(false); // B's own request is still unanswered -- untouched by A's resolution

    provider.resolveApproval(forB.id, { choice: 'deny' });
    const bResult = (await b) as Record<string, unknown>;
    expect(bSettled).toBe(true);
    expect(bResult.error).toBe(true);
  });

  it('cancelling the turn (aborting ctx.signal) while an approval is pending resolves it as a denial and cleans up, rather than hanging forever', async () => {
    const { provider } = makeProvider();
    const tools = await provider.listTools(policy());
    const writeFile = tools.find((t) => t.name === 'write_file')!;

    const controller = new AbortController();
    const promise = writeFile.execute({ path: 'cancel-me.txt', content: 'x' }, ctx({ signal: controller.signal }));
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    const result = (await promise) as Record<string, unknown>;
    expect(result.error).toBe(true);
    expect(result.code).toBe('approval_denied');
  });
});
