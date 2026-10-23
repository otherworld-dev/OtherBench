import { beforeEach, describe, expect, it } from 'vitest';
import { MEDIA_OFF_REASON, PermissionBroker, SUBAGENT_MEDIA_REFUSAL, UNATTENDED_REASON } from '../src/domain/permissions.js';
import { PLAN_REFUSAL } from '../src/domain/thread-tools.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { ToolPolicy } from '../src/types/config.js';
import { InMemoryStore } from '../src/testing/fakes.js';

const IMAGE: ToolSpec = { name: 'generate_image', description: '', parameters: {}, risk: 'execute', source: 'media', execute: async () => null };
const VIDEO: ToolSpec = { name: 'generate_video', description: '', parameters: {}, risk: 'execute', source: 'media', execute: async () => null };
const OTHER: ToolSpec = { name: 'generate_audio', description: '', parameters: {}, risk: 'execute', source: 'media', execute: async () => null };

function policy(over: Partial<ToolPolicy> = {}): ToolPolicy {
  return { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', media: { image: { connectionId: 'c1' } }, ...over } as ToolPolicy;
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal, ...over };
}

describe('PermissionBroker and media generation', () => {
  let store: InMemoryStore;
  let broker: PermissionBroker;

  function grant(over: Record<string, unknown> = {}): void {
    store.grants.create({
      id: `g${store.grants.list().length + 1}`,
      chatId: 'chat-1',
      profileId: 'profile-1',
      toolName: 'generate_image',
      source: 'media',
      scope: 'chat',
      constraint: null,
      expiresAt: null,
      ...over,
    });
  }

  beforeEach(() => {
    store = new InMemoryStore();
    broker = new PermissionBroker(store);
  });

  it('refuses a tool whose choice the profile has not set', () => {
    expect(broker.decide(IMAGE, {}, policy({ media: undefined }), ctx())).toEqual({ kind: 'deny', reason: MEDIA_OFF_REASON });
    expect(broker.decide(IMAGE, {}, policy({ media: {} }), ctx())).toEqual({ kind: 'deny', reason: MEDIA_OFF_REASON });
    expect(broker.decide(VIDEO, {}, policy(), ctx())).toEqual({ kind: 'deny', reason: MEDIA_OFF_REASON });
    expect(broker.decide(OTHER, {}, policy({ media: { image: { connectionId: 'c1' }, video: { connectionId: 'c2' } } }), ctx())).toEqual({ kind: 'deny', reason: MEDIA_OFF_REASON });
  });

  it('allows a configured tool by policy under ask_on_mutate, attended or not, with confirmPrompts on or off', () => {
    const video = policy({ media: { video: { connectionId: 'c2' } } });
    for (const p of [policy(), policy({ media: { image: { connectionId: 'c1' }, confirmPrompts: false } })]) {
      expect(broker.decide(IMAGE, {}, p, ctx())).toEqual({ kind: 'allow', grantedBy: 'policy' });
      expect(broker.decide(IMAGE, {}, p, ctx({ unattended: true }))).toEqual({ kind: 'allow', grantedBy: 'policy' });
    }
    expect(broker.decide(VIDEO, {}, video, ctx())).toEqual({ kind: 'allow', grantedBy: 'policy' });
  });

  it('asks under always_ask with confirmPrompts off, and a chat grant covers the tool by name and source', () => {
    const p = policy({ approvalMode: 'always_ask', media: { image: { connectionId: 'c1' }, confirmPrompts: false } });
    const asked = broker.decide(IMAGE, { prompt: 'a cat' }, p, ctx());
    expect(asked).toMatchObject({ kind: 'ask', request: { toolName: 'generate_image', source: 'media', risk: 'execute' } });
    grant();
    expect(broker.decide(IMAGE, {}, p, ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    // Another chat, another profile and another tool are not covered.
    expect(broker.decide(IMAGE, {}, p, ctx({ chatId: 'chat-2' })).kind).toBe('ask');
    expect(broker.decide(IMAGE, {}, p, ctx({ profileId: 'profile-2' })).kind).toBe('ask');
    expect(broker.decide(VIDEO, {}, policy({ approvalMode: 'always_ask', media: { video: { connectionId: 'c2' }, confirmPrompts: false } }), ctx()).kind).toBe('ask');
  });

  it('mints a chat and an always grant from a card answer, and later calls match it', () => {
    const p = policy({ approvalMode: 'always_ask', media: { image: { connectionId: 'c1' }, confirmPrompts: false } });
    for (const choice of ['chat', 'always'] as const) {
      store = new InMemoryStore();
      broker = new PermissionBroker(store);
      const asked = broker.decide(IMAGE, { prompt: 'x' }, p, ctx());
      if (asked.kind !== 'ask') throw new Error('expected ask');
      broker.resolve(asked.request.id, { choice });
      expect(store.grants.list()).toHaveLength(1);
      expect(store.grants.list()[0]).toMatchObject({ toolName: 'generate_image', source: 'media', profileId: 'profile-1', constraint: null });
      expect(broker.decide(IMAGE, { prompt: 'y' }, p, ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    }
  });

  it('refuses an always grant that carries a constraint', () => {
    const asked = broker.decide(IMAGE, {}, policy({ approvalMode: 'always_ask', media: { image: { connectionId: 'c1' }, confirmPrompts: false } }), ctx());
    if (asked.kind !== 'ask') throw new Error('expected ask');
    expect(() => broker.resolve(asked.request.id, { choice: 'always', constraint: { pathPrefix: '.' } })).toThrow(/media/);
  });

  it('allows by policy under always_ask when the generation ask is the confirmation (confirmPrompts on or absent, attended)', () => {
    for (const p of [policy({ approvalMode: 'always_ask' }), policy({ approvalMode: 'always_ask', media: { image: { connectionId: 'c1' }, confirmPrompts: true } })]) {
      expect(broker.decide(IMAGE, { prompt: 'a cat' }, p, ctx())).toEqual({ kind: 'allow', grantedBy: 'policy' });
    }
    expect(broker.pendingCount).toBe(0);
  });

  it('still asks under always_ask with confirmPrompts off', () => {
    const p = policy({ approvalMode: 'always_ask', media: { image: { connectionId: 'c1' }, confirmPrompts: false } });
    expect(broker.decide(IMAGE, {}, p, ctx()).kind).toBe('ask');
  });

  it('refuses unattended under always_ask without a grant, and allows it with one', () => {
    const p = policy({ approvalMode: 'always_ask' });
    expect(broker.decide(IMAGE, {}, p, ctx({ unattended: true }))).toEqual({ kind: 'deny', reason: UNATTENDED_REASON, unattended: true });
    expect(broker.pendingCount).toBe(0);
    grant({ chatId: null, scope: 'always' });
    expect(broker.decide(IMAGE, {}, p, ctx({ unattended: true }))).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
  });

  it("is never a sub-agent's", () => {
    const subagent = { id: 's1', label: 'x' } as unknown as ToolContext['subagent'];
    expect(broker.decide(IMAGE, {}, policy(), ctx({ subagent }))).toEqual({ kind: 'deny', reason: SUBAGENT_MEDIA_REFUSAL });
    grant({ chatId: null, scope: 'always' });
    expect(broker.decide(IMAGE, {}, policy({ approvalMode: 'always_ask' }), ctx({ subagent }))).toEqual({ kind: 'deny', reason: SUBAGENT_MEDIA_REFUSAL });
  });

  it("is never a Claude Code helper's, under either approval mode", () => {
    const shownSubagent = { callId: 'c1', label: 'x', parentProfileId: 'profile-1' } as unknown as ToolContext['shownSubagent'];
    for (const approvalMode of ['ask_on_mutate', 'always_ask'] as const) {
      expect(broker.decide(IMAGE, {}, policy({ approvalMode }), ctx({ shownSubagent }))).toEqual({ kind: 'deny', reason: SUBAGENT_MEDIA_REFUSAL });
    }
  });

  it('is refused while the reply plan waits, and allowed once it is approved', () => {
    expect(broker.decide(IMAGE, {}, policy(), ctx({ plan: { approved: false } as ToolContext['plan'] }))).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
    expect(broker.decide(IMAGE, {}, policy(), ctx({ plan: { approved: true } as ToolContext['plan'] }))).toEqual({ kind: 'allow', grantedBy: 'policy' });
  });
});
