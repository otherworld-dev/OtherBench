import { describe, expect, it } from 'vitest';
import type { EngineRequest } from '../src/ports/chat-engine.js';
import type { SubagentHost } from '../src/ports/tool-provider.js';
import type { ResolvedProfile } from '../src/types/config.js';
import { toolContextFor } from '../src/domain/tool-context.js';

function request(over: Partial<EngineRequest> = {}): EngineRequest {
  return {
    profile: { id: 'profile-1' } as ResolvedProfile,
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    chatId: 'chat-1',
    messageId: 'reply-1',
    workspaceRoot: '/ws',
    ...over,
  };
}

describe('toolContextFor', () => {
  it('copies the ids, profile, workspace and signal, and leaves out what the request lacks', () => {
    const req = request();
    expect(toolContextFor(req)).toEqual({ chatId: 'chat-1', messageId: 'reply-1', profileId: 'profile-1', workspaceRoot: '/ws', signal: req.signal });
  });

  it('carries the call id, the sub-agent host and the sub-agent tag', () => {
    const host: SubagentHost = { run: async () => 'ok' };
    const other = new AbortController().signal;
    const ctx = toolContextFor(request({ subagents: host, subagent: { callId: 'c1', label: 'Helper', parentProfileId: 'profile-1' }, folders: [{ root: '/x', access: 'read' }] }), other, 'call-9');
    expect(ctx).toMatchObject({ toolCallId: 'call-9', subagents: host, subagent: { callId: 'c1', label: 'Helper', parentProfileId: 'profile-1' }, folders: [{ root: '/x', access: 'read' }], signal: other });
  });

  it("scopes a sub-agent's calls to the parent reply's profile, not the one it runs as", () => {
    const ctx = toolContextFor(request({ profile: { id: 'profile-b' } as ResolvedProfile, subagent: { callId: 'c1', label: 'Helper', parentProfileId: 'profile-a', profileName: 'B' } }));
    expect(ctx.profileId).toBe('profile-a');
  });

  it('leaves out an empty folder list', () => {
    expect(toolContextFor(request({ folders: [] }))).not.toHaveProperty('folders');
  });
});
