import { describe, expect, it } from 'vitest';
import type { PeersOverview } from './api.js';
import { chatsInBackgroundElsewhere, computerSessionElsewhere } from './peerActivity.js';

const overview = (peers: { status: string; nodeId?: string; name?: string; backgroundChats?: string[]; computerSessions?: { chatId: string; lastAction?: string }[] }[]): PeersOverview => ({ peers }) as unknown as PeersOverview;

describe('chatsInBackgroundElsewhere', () => {
  it("is every reachable paired machine's chats with background tasks, and none from one out of reach or an older machine", () => {
    const machines = overview([
      { status: 'reachable', backgroundChats: ['a', 'b'] },
      { status: 'unreachable', backgroundChats: ['c'] },
      { status: 'reachable' },
    ]);
    expect([...chatsInBackgroundElsewhere(machines)]).toEqual(['a', 'b']);
    expect(chatsInBackgroundElsewhere(null).size).toBe(0);
  });
});

describe('computerSessionElsewhere', () => {
  it('is the reachable paired machine a chat is controlling, with its last action; none out of reach or for another chat', () => {
    const machines = overview([
      { status: 'unreachable', nodeId: 'n1', name: 'Old', computerSessions: [{ chatId: 'a' }] },
      { status: 'reachable', nodeId: 'n2', name: 'PC', computerSessions: [{ chatId: 'a', lastAction: 'take a screenshot' }] },
      { status: 'reachable', nodeId: 'n3', name: 'Mini' },
    ]);
    expect(computerSessionElsewhere(machines, 'a')).toEqual({ nodeId: 'n2', machine: 'PC', lastAction: 'take a screenshot' });
    expect(computerSessionElsewhere(machines, 'b')).toBeNull();
    expect(computerSessionElsewhere(overview([{ status: 'reachable', nodeId: 'n2', name: 'PC', computerSessions: [{ chatId: 'a' }] }]), 'a')).toEqual({ nodeId: 'n2', machine: 'PC' });
    expect(computerSessionElsewhere(null, 'a')).toBeNull();
  });
});
