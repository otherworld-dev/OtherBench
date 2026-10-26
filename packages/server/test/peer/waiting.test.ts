import { afterEach, describe, expect, it } from 'vitest';
import { makeNode, pair, type TestNode } from './helpers.js';

const nodes: TestNode[] = [];
function node(name: string): TestNode {
  const n = makeNode(name, { minBackoffMs: 20, maxBackoffMs: 80 });
  nodes.push(n);
  return n;
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.close()));
});

async function connected(): Promise<{ pc: TestNode; laptop: TestNode }> {
  const pc = node('PC');
  const laptop = node('Laptop');
  await pair(pc, laptop);
  laptop.service.startMonitoring();
  await expect.poll(() => laptop.service.status('node-PC').status).toBe('reachable');
  return { pc, laptop };
}

describe('activity: waiting chats and gh login', () => {
  it('tells a peer which chats wait on a card and which gh login it has, and again when they change', async () => {
    const { pc, laptop } = await connected();
    let waiting = ['c1'];
    let login: string | null = 'octo';
    pc.service.attachActivity(() => [], () => [], () => waiting);
    pc.service.setGithubLogin(() => login);

    pc.service.announceActivity();
    await expect.poll(() => laptop.service.waitingChats('node-PC')).toEqual(['c1']);
    expect(laptop.service.githubLogin('node-PC')).toBe('octo');

    waiting = [];
    login = null;
    pc.service.announceActivity();
    await expect.poll(() => laptop.service.waitingChats('node-PC')).toEqual([]);
    expect(laptop.service.githubLogin('node-PC')).toBeNull();
  });

  it('reads an older peer, which says neither, as none waiting and no login; non-strings are dropped', async () => {
    const { pc, laptop } = await connected();
    pc.service.announce('activity', { chatIds: ['a'], waitingChatIds: ['w', 3, null], githubLogin: 'x' });
    await expect.poll(() => laptop.service.waitingChats('node-PC')).toEqual(['w']);
    pc.service.announce('activity', { chatIds: ['a'], backgroundChatIds: [] });
    await expect.poll(() => laptop.service.waitingChats('node-PC')).toEqual([]);
    expect(laptop.service.githubLogin('node-PC')).toBeNull();
    pc.service.announce('activity', { githubLogin: 5 });
    await expect.poll(() => laptop.service.activeChats('node-PC')).toEqual([]);
    expect(laptop.service.githubLogin('node-PC')).toBeNull();
  });
});
