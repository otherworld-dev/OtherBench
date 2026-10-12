import { describe, expect, it } from 'vitest';
import { toolContextFor } from '../src/domain/tool-context.js';
import { createPlanGate } from '../src/domain/thread-tools.js';
import type { EngineRequest } from '../src/ports/chat-engine.js';

const req = (o: Partial<EngineRequest> = {}): EngineRequest =>
  ({ profile: { id: 'p1' }, messages: [], tools: [], signal: new AbortController().signal, chatId: 'c1', messageId: 'm1', workspaceRoot: '/ws', ...o }) as EngineRequest;

describe('toolContextFor', () => {
  it('carries the ids, profile, workspace and signal', () => {
    const r = req();
    expect(toolContextFor(r)).toEqual({ chatId: 'c1', messageId: 'm1', profileId: 'p1', workspaceRoot: '/ws', signal: r.signal });
  });
  it('adds folders, the plan gate and unattended only when set, and takes a call signal', () => {
    const plan = createPlanGate();
    const folders = [{ path: '/other', access: 'read' }] as never;
    const call = new AbortController().signal;
    expect(toolContextFor(req({ folders, plan, unattended: true }), call)).toEqual({ chatId: 'c1', messageId: 'm1', profileId: 'p1', workspaceRoot: '/ws', folders, plan, unattended: true, signal: call });
    expect(toolContextFor(req({ folders: [] }))).not.toHaveProperty('folders');
  });
});
