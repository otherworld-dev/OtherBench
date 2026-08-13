import { describe, it, expect, beforeEach } from 'vitest';
import { PermissionBroker } from '../src/domain/permissions.js';
import type { Decision } from '../src/domain/permissions.js';
import type { RiskClass, ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { ToolPolicy } from '../src/types/config.js';
import { InMemoryStore } from '../src/testing/fakes.js';

function makeTool(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name: 'read_file',
    description: 'Reads a file.',
    parameters: {},
    risk: 'read',
    source: 'fs',
    execute: async () => null,
    ...overrides,
  };
}

const READ_FILE = () => makeTool({ name: 'read_file', risk: 'read', source: 'fs' });
const WRITE_FILE = () => makeTool({ name: 'write_file', risk: 'mutate', source: 'fs' });
const RUN_COMMAND = () => makeTool({ name: 'run_command', risk: 'execute', source: 'shell' });
const MCP_TOOL = (risk: RiskClass = 'read') => makeTool({ name: 'mcp_search', risk, source: 'mcp' });

function makePolicy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return { fs: 'readwrite', shell: true, mcpServerIds: ['srv-1'], approvalMode: 'ask_on_mutate', ...overrides };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    chatId: 'chat-1',
    messageId: 'msg-1',
    workspaceRoot: '/ws',
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Narrows a Decision to its 'ask' variant, throwing with a useful message if it wasn't. */
function expectAsk(decision: Decision): Extract<Decision, { kind: 'ask' }> {
  if (decision.kind !== 'ask') {
    throw new Error(`Expected an 'ask' decision, got: ${JSON.stringify(decision)}`);
  }
  return decision;
}

describe('PermissionBroker', () => {
  let store: InMemoryStore;
  let broker: PermissionBroker;

  beforeEach(() => {
    store = new InMemoryStore();
    broker = new PermissionBroker(store);
  });

  describe('policy gate', () => {
    it('denies a shell tool outright when policy.shell is false, without creating an approval request', () => {
      const decision = broker.decide(RUN_COMMAND(), { command: 'echo hi' }, makePolicy({ shell: false }), makeCtx());
      expect(decision.kind).toBe('deny');
      // No approval request was ever created, so no request id exists to resolve.
      expect(() => broker.resolve('anything', { choice: 'once' })).toThrow();
    });

    it('denies fs tools outright when policy.fs is off, without creating an approval request', () => {
      const policy = makePolicy({ fs: 'off' });
      expect(broker.decide(READ_FILE(), { path: 'a.txt' }, policy, makeCtx()).kind).toBe('deny');
      expect(broker.decide(WRITE_FILE(), { path: 'a.txt' }, policy, makeCtx()).kind).toBe('deny');
      expect(() => broker.resolve('anything', { choice: 'once' })).toThrow();
    });

    it("fs: 'read' allows read_file but denies write_file", () => {
      const policy = makePolicy({ fs: 'read' });
      const readDecision = broker.decide(READ_FILE(), { path: 'a.txt' }, policy, makeCtx());
      expect(readDecision.kind).not.toBe('deny');
      const writeDecision = broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, policy, makeCtx());
      expect(writeDecision.kind).toBe('deny');
    });

    it('denies an mcp tool when no mcp servers are enabled by policy', () => {
      const decision = broker.decide(MCP_TOOL(), {}, makePolicy({ mcpServerIds: [] }), makeCtx());
      expect(decision.kind).toBe('deny');
    });
  });

  describe('workspace root requirement', () => {
    it('denies an fs tool when no workspace root is configured for the chat', () => {
      const decision = broker.decide(READ_FILE(), { path: 'a.txt' }, makePolicy(), makeCtx({ workspaceRoot: null }));
      expect(decision.kind).toBe('deny');
    });

    it('denies a shell tool when no workspace root is configured for the chat', () => {
      const decision = broker.decide(RUN_COMMAND(), { command: 'ls' }, makePolicy(), makeCtx({ workspaceRoot: null }));
      expect(decision.kind).toBe('deny');
    });
  });

  describe('auto-approval', () => {
    it('a read tool inside workspace_root returns allow with grantedBy auto_read', () => {
      const decision = broker.decide(READ_FILE(), { path: 'a.txt' }, makePolicy(), makeCtx({ workspaceRoot: '/ws' }));
      expect(decision).toEqual({ kind: 'allow', grantedBy: 'auto_read' });
    });

    it("asks for a read tool when approvalMode is 'always_ask' instead of auto-approving", () => {
      const decision = broker.decide(READ_FILE(), { path: 'a.txt' }, makePolicy({ approvalMode: 'always_ask' }), makeCtx());
      expect(decision.kind).toBe('ask');
    });

    it('asks for a mutate tool even under ask_on_mutate when no grant exists', () => {
      const decision = broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, makePolicy(), makeCtx());
      const ask = expectAsk(decision);
      expect(ask.request.toolName).toBe('write_file');
      expect(ask.request.risk).toBe('mutate');
      expect(ask.request.chatId).toBe('chat-1');
      expect(ask.request.messageId).toBe('msg-1');
    });

    it('allows a read-risk mcp tool via policy when its server is enabled', () => {
      const decision = broker.decide(MCP_TOOL('read'), {}, makePolicy({ mcpServerIds: ['srv-1'] }), makeCtx());
      expect(decision).toEqual({ kind: 'allow', grantedBy: 'policy' });
    });

    it('still asks for a mutate-risk mcp tool even though its server is enabled', () => {
      const decision = broker.decide(MCP_TOOL('mutate'), {}, makePolicy(), makeCtx());
      expect(decision.kind).toBe('ask');
    });
  });

  describe('shell never auto-approves', () => {
    it('never returns allow for a shell tool without a matching grant, under either approvalMode', () => {
      for (const approvalMode of ['always_ask', 'ask_on_mutate'] as const) {
        const decision = broker.decide(RUN_COMMAND(), { command: 'ls' }, makePolicy({ approvalMode }), makeCtx());
        expect(decision.kind).toBe('ask');
      }
    });

    it('never auto-approves a shell-source tool even if its risk is (incorrectly) declared read', () => {
      const rogueShellTool = makeTool({ name: 'run_command', source: 'shell', risk: 'read' });
      const decision = broker.decide(
        rogueShellTool,
        { command: 'echo hi' },
        makePolicy({ approvalMode: 'ask_on_mutate' }),
        makeCtx()
      );
      expect(decision.kind).toBe('ask');
    });
  });

  describe('grant matching', () => {
    it('an existing chat-scope grant for the same tool allows; a grant for a different chat does not', () => {
      store.grants.create({
        id: 'g1',
        chatId: 'chat-1',
        profileId: null,
        toolName: 'write_file',
        scope: 'chat',
        constraint: null,
        expiresAt: null,
      });

      const sameChat = broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, makePolicy(), makeCtx({ chatId: 'chat-1' }));
      expect(sameChat).toEqual({ kind: 'allow', grantedBy: 'grant', grantId: 'g1' });

      const otherChat = broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, makePolicy(), makeCtx({ chatId: 'chat-2' }));
      expect(otherChat.kind).toBe('ask');
    });

    it('a pathPrefix constraint matches by path segment, not by raw string prefix', () => {
      store.grants.create({
        id: 'g1',
        chatId: null,
        profileId: null,
        toolName: 'write_file',
        scope: 'always',
        constraint: { pathPrefix: '/ws/src' },
        expiresAt: null,
      });

      // /ws/src-secret shares the string prefix "/ws/src" but is NOT inside it.
      const escapee = broker.decide(WRITE_FILE(), { path: '/ws/src-secret/f' }, makePolicy(), makeCtx());
      expect(escapee.kind).toBe('ask');

      const legit = broker.decide(WRITE_FILE(), { path: '/ws/src/f.ts' }, makePolicy(), makeCtx());
      expect(legit).toEqual({ kind: 'allow', grantedBy: 'grant', grantId: 'g1' });

      const exact = broker.decide(WRITE_FILE(), { path: '/ws/src' }, makePolicy(), makeCtx());
      expect(exact).toEqual({ kind: 'allow', grantedBy: 'grant', grantId: 'g1' });
    });

    it('a commandPrefix grant on "npm test" does not authorise "npm test && rm -rf /"', () => {
      store.grants.create({
        id: 'g1',
        chatId: null,
        profileId: null,
        toolName: 'run_command',
        scope: 'always',
        constraint: { commandPrefix: 'npm test' },
        expiresAt: null,
      });

      const safe = broker.decide(RUN_COMMAND(), { command: 'npm test' }, makePolicy(), makeCtx());
      expect(safe).toEqual({ kind: 'allow', grantedBy: 'grant', grantId: 'g1' });

      const plainArgs = broker.decide(RUN_COMMAND(), { command: 'npm test --watch' }, makePolicy(), makeCtx());
      expect(plainArgs).toEqual({ kind: 'allow', grantedBy: 'grant', grantId: 'g1' });

      // The constraint must match the full argv prefix, not a substring: chaining
      // another command after the approved prefix must NOT be authorised.
      const chained = broker.decide(RUN_COMMAND(), { command: 'npm test && rm -rf /' }, makePolicy(), makeCtx());
      expect(chained.kind).toBe('ask');

      // Nor may an adjacent token that merely shares the prefix's text sneak through.
      const adjacentToken = broker.decide(RUN_COMMAND(), { command: 'npm testing' }, makePolicy(), makeCtx());
      expect(adjacentToken.kind).toBe('ask');
    });

    it('ignores an expired grant', () => {
      store.grants.create({
        id: 'g1',
        chatId: 'chat-1',
        profileId: null,
        toolName: 'write_file',
        scope: 'chat',
        constraint: null,
        expiresAt: Date.now() - 1000,
      });
      const decision = broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, makePolicy(), makeCtx());
      expect(decision.kind).toBe('ask');
    });
  });

  describe('resolve()', () => {
    it('throws for an unknown or already-resolved request id', () => {
      expect(() => broker.resolve('nope', { choice: 'deny' })).toThrow();
    });

    it("persists no grant for 'deny' or 'once' choices", () => {
      const first = expectAsk(broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, makePolicy(), makeCtx()));
      broker.resolve(first.request.id, { choice: 'deny' });
      expect(store.grants.list()).toHaveLength(0);

      const second = expectAsk(broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, makePolicy(), makeCtx()));
      broker.resolve(second.request.id, { choice: 'once' });
      expect(store.grants.list()).toHaveLength(0);
    });

    it('resolving the same request id twice throws the second time', () => {
      const first = expectAsk(broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, makePolicy(), makeCtx()));
      broker.resolve(first.request.id, { choice: 'deny' });
      expect(() => broker.resolve(first.request.id, { choice: 'deny' })).toThrow();
    });

    it("'chat' persists a chat-scoped grant that a later identical-tool call in the same chat is allowed by", () => {
      const first = expectAsk(broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, makePolicy(), makeCtx()));
      broker.resolve(first.request.id, { choice: 'chat' });

      const grants = store.grants.list();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ chatId: 'chat-1', toolName: 'write_file', scope: 'chat', constraint: null });

      const second = broker.decide(WRITE_FILE(), { path: 'b.txt', content: 'y' }, makePolicy(), makeCtx());
      expect(second.kind).toBe('allow');

      const otherChat = broker.decide(WRITE_FILE(), { path: 'a.txt', content: 'x' }, makePolicy(), makeCtx({ chatId: 'chat-2' }));
      expect(otherChat.kind).toBe('ask');
    });

    it("'always' persists a global grant scoped by the given constraint", () => {
      const first = expectAsk(broker.decide(WRITE_FILE(), { path: '/ws/src/a.ts' }, makePolicy(), makeCtx()));
      broker.resolve(first.request.id, { choice: 'always', constraint: { pathPrefix: '/ws/src' } });

      const grants = store.grants.list();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ chatId: null, scope: 'always', constraint: { pathPrefix: '/ws/src' } });

      const otherChat = broker.decide(WRITE_FILE(), { path: '/ws/src/b.ts' }, makePolicy(), makeCtx({ chatId: 'chat-9' }));
      expect(otherChat.kind).toBe('allow');
    });

    it('refuses to create a blanket always-grant for a shell tool without a commandPrefix constraint, and persists nothing', () => {
      const first = expectAsk(broker.decide(RUN_COMMAND(), { command: 'ls' }, makePolicy(), makeCtx()));
      expect(() => broker.resolve(first.request.id, { choice: 'always', constraint: null })).toThrow();
      expect(store.grants.list()).toHaveLength(0);
    });

    it('creates an always-grant for a shell tool when a commandPrefix constraint is supplied', () => {
      const first = expectAsk(broker.decide(RUN_COMMAND(), { command: 'npm test' }, makePolicy(), makeCtx()));
      broker.resolve(first.request.id, { choice: 'always', constraint: { commandPrefix: 'npm test' } });
      expect(store.grants.list()).toHaveLength(1);

      const second = broker.decide(RUN_COMMAND(), { command: 'npm test' }, makePolicy(), makeCtx());
      expect(second.kind).toBe('allow');
    });
  });
});
