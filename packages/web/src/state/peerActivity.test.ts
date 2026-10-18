import { describe, expect, it } from 'vitest';
import type { PeersOverview } from './api.js';
import { chatsInBackgroundElsewhere } from './peerActivity.js';

const overview = (peers: { status: string; backgroundChats?: string[] }[]): PeersOverview => ({ peers }) as unknown as PeersOverview;

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
