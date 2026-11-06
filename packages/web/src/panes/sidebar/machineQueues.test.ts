import { describe, expect, it } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { PeersOverview } from '../../state/api.js';
import { splitByMachine, UNPAIRED_MACHINE_KEY } from './machineQueues.js';

const chat = (id: string, runsOn: string): Chat => ({ id, runsOn }) as Chat;

const machines = {
  self: { id: 'lap', name: 'Laptop', fingerprint: 'f' },
  listening: { running: true, addresses: [] },
  peers: [
    { nodeId: 'pc', name: 'PC', status: 'reachable' },
    { nodeId: 'nas', name: 'NAS', status: 'unreachable' },
  ],
} as unknown as PeersOverview;

const ids = (chats: Chat[]): string[] => chats.map((c) => c.id);

describe('splitByMachine', () => {
  it("puts this machine's chats first and gives each other machine its own section, keeping the queue order", () => {
    const { here, elsewhere } = splitByMachine([chat('a', 'nas'), chat('b', 'pc'), chat('c', 'lap'), chat('d', 'pc'), chat('e', 'lap')], machines);
    expect(ids(here)).toEqual(['c', 'e']);
    // The paired machines' order, not the order their first chat came in.
    expect(elsewhere.map((m) => [m.key, m.name, ids(m.chats)])).toEqual([
      ['pc', 'PC', ['b', 'd']],
      ['nas', 'NAS', ['a']],
    ]);
  });

  it('leaves out a machine with nothing waiting', () => {
    expect(splitByMachine([chat('a', 'pc')], machines).elsewhere.map((m) => m.key)).toEqual(['pc']);
  });

  it('gathers chats on machines no longer paired at the end', () => {
    const { elsewhere } = splitByMachine([chat('a', 'gone-1'), chat('b', 'pc'), chat('c', 'gone-2')], machines);
    expect(elsewhere.map((m) => [m.key, ids(m.chats)])).toEqual([
      ['pc', ['b']],
      [UNPAIRED_MACHINE_KEY, ['a', 'c']],
    ]);
  });

  it("counts every chat as this machine's until the machines load", () => {
    const { here, elsewhere } = splitByMachine([chat('a', 'pc'), chat('b', 'lap')], null);
    expect(ids(here)).toEqual(['a', 'b']);
    expect(elsewhere).toEqual([]);
  });
});
