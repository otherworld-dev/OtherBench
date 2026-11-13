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

  it('tells a peer whether it accepts chat sends; an older peer, which does not say, reads as unknown (null)', async () => {
    const { pc, laptop } = await connected();
    let accepts = true;
    pc.service.setAcceptsChatSends(() => accepts);
    expect(pc.service.activity().acceptsChatSends).toBe(true);
    pc.service.announceActivity();
    await expect.poll(() => laptop.service.acceptsChatSends('node-PC')).toBe(true);
    accepts = false;
    pc.service.announceActivity();
    await expect.poll(() => laptop.service.acceptsChatSends('node-PC')).toBe(false);
    pc.service.announce('activity', { chatIds: [] });
    await expect.poll(() => laptop.service.acceptsChatSends('node-PC')).toBeNull();
  });

  it('tells a peer when each of those chats started waiting, so its Needs you list orders them as this one does', async () => {
    const { pc, laptop } = await connected();
    let waiting: Record<string, number> = { c1: 100, c2: 200 };
    pc.service.attachActivity(() => [], () => [], () => Object.keys(waiting), () => waiting);

    pc.service.announceActivity();
    await expect.poll(() => laptop.service.waitingSince('node-PC')).toEqual({ c1: 100, c2: 200 });

    waiting = {};
    pc.service.announceActivity();
    await expect.poll(() => laptop.service.waitingSince('node-PC')).toEqual({});
  });

  it("drops a time that isn't a number, or is for a chat it doesn't say is waiting; an older peer says none", async () => {
    const { pc, laptop } = await connected();
    pc.service.announce('activity', { waitingChatIds: ['w', 'x', 'y'], waitingSince: { w: 5, x: 'soon', y: null, z: 9 } });
    await expect.poll(() => laptop.service.waitingSince('node-PC')).toEqual({ w: 5 });
    pc.service.announce('activity', { waitingChatIds: ['w'] });
    await expect.poll(() => laptop.service.waitingSince('node-PC')).toEqual({});
    pc.service.announce('activity', { waitingChatIds: ['w'], waitingSince: [5] });
    await expect.poll(() => laptop.service.waitingChats('node-PC')).toEqual(['w']);
    expect(laptop.service.waitingSince('node-PC')).toEqual({});
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

  it('tells a peer which chat controls this computer and its last action, and again when it ends; none while unreachable', async () => {
    const { pc, laptop } = await connected();
    let sessions: { chatId: string; lastAction?: string }[] = [{ chatId: 'c1' }];
    pc.service.attachActivity(() => [], () => [], () => [], () => ({}), () => sessions);

    pc.service.announceActivity();
    await expect.poll(() => laptop.service.computerSessions('node-PC')).toEqual([{ chatId: 'c1' }]);
    sessions = [{ chatId: 'c1', lastAction: 'left click at 10, 20' }];
    pc.service.announceActivity();
    await expect.poll(() => laptop.service.computerSessions('node-PC')).toEqual([{ chatId: 'c1', lastAction: 'left click at 10, 20' }]);
    sessions = [];
    pc.service.announceActivity();
    await expect.poll(() => laptop.service.computerSessions('node-PC')).toEqual([]);

    // Said again, then the PC goes away: an unreachable machine controls nothing as far as this one shows.
    sessions = [{ chatId: 'c1' }];
    pc.service.announceActivity();
    await expect.poll(() => laptop.service.computerSessions('node-PC')).toEqual([{ chatId: 'c1' }]);
    await pc.service.listener.stop();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('unreachable');
    expect(laptop.service.computerSessions('node-PC')).toEqual([]);
  });

  it('hears the sessions again in the activity that follows the hello when the stream comes back', async () => {
    const { pc, laptop } = await connected();
    pc.service.attachActivity(() => [], () => [], () => [], () => ({}), () => [{ chatId: 'c1', lastAction: 'take a screenshot' }]);
    pc.service.announceActivity();
    await expect.poll(() => laptop.service.computerSessions('node-PC')).toHaveLength(1);
    await pc.service.listener.stop();
    await expect.poll(() => laptop.service.status('node-PC').status).toBe('unreachable');
    await pc.service.listener.start();
    laptop.service.monitor.retryNow();
    // Nobody announced anything new: the stream's opening activity carries it.
    await expect.poll(() => laptop.service.computerSessions('node-PC'), { timeout: 5000 }).toEqual([{ chatId: 'c1', lastAction: 'take a screenshot' }]);
  });

  it('keeps only bounded strings from what a peer says of its computer sessions, and nothing else in an entry', async () => {
    const { pc, laptop } = await connected();
    pc.service.announce('activity', {
      computerSessions: [
        { chatId: 'ok', lastAction: 'press ctrl+s', screenshot: 'iVBORw0KGgo', app: 'C:/Tools/secret.exe' },
        { chatId: 5 },
        { lastAction: 'no chat' },
        null,
        'c2',
        { chatId: 'x'.repeat(201) },
        { chatId: 'long', lastAction: 'y'.repeat(500) },
        { chatId: 'n', lastAction: 7 },
        { chatId: 'a' }, { chatId: 'b' }, { chatId: 'c' },
      ],
    });
    await expect.poll(() => laptop.service.computerSessions('node-PC')).toHaveLength(4);
    const kept = laptop.service.computerSessions('node-PC');
    expect(kept[0]).toEqual({ chatId: 'ok', lastAction: 'press ctrl+s' });
    expect(kept[1]).toEqual({ chatId: 'long', lastAction: 'y'.repeat(200) });
    expect(kept[2]).toEqual({ chatId: 'n' });
    expect(kept[3]).toEqual({ chatId: 'a' });
    // An older machine says nothing about it: none.
    pc.service.announce('activity', { chatIds: [] });
    await expect.poll(() => laptop.service.computerSessions('node-PC')).toEqual([]);
    pc.service.announce('activity', { computerSessions: { chatId: 'ok' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(laptop.service.computerSessions('node-PC')).toEqual([]);
  });

  it('says only ids, times, a login, the action line and whether it takes chat sends: the whole of what a paired machine hears live', () => {
    const pc = node('PC');
    // A computer-use session is told as its chat and last action only (d1109): not which machine started it, and
    // nothing of the screen or the app, which the session here doesn't carry either.
    pc.service.attachActivity(() => ['r'], () => ['b'], () => ['w'], () => ({ w: 1 }), () => [{ chatId: 'c', lastAction: 'take a screenshot', startedFrom: 'Laptop' }]);
    expect(pc.service.activity()).toEqual({
      chatIds: ['r'], backgroundChatIds: ['b'], waitingChatIds: ['w'], waitingSince: { w: 1 }, githubLogin: null,
      computerSessions: [{ chatId: 'c', lastAction: 'take a screenshot' }], acceptsChatSends: false,
    });
  });

  it('forgets what a removed machine said', async () => {
    const { pc, laptop } = await connected();
    pc.service.announce('activity', { computerSessions: [{ chatId: 'c1' }], waitingChatIds: ['w'] });
    await expect.poll(() => laptop.service.computerSessions('node-PC')).toEqual([{ chatId: 'c1' }]);
    await laptop.service.remove('node-PC');
    expect(laptop.service.computerSessions('node-PC')).toEqual([]);
    expect(laptop.service.waitingChats('node-PC')).toEqual([]);
  });
});

describe('computer-start: how a start a paired machine asked for came out', () => {
  it('goes only to the machine that asked, as the chat and one of three outcomes', async () => {
    const { pc, laptop } = await connected();
    const tablet = node('Tablet');
    await pair(pc, tablet);
    tablet.service.startMonitoring();
    await expect.poll(() => tablet.service.status('node-PC').status).toBe('reachable');

    pc.service.announceTo('node-Laptop', 'computer-start', { chatId: 'c1', outcome: 'declined' });
    await expect.poll(() => laptop.events.filter((e) => e.type === 'peer-computer-start')).toEqual([
      { type: 'peer-computer-start', nodeId: 'node-PC', chatId: 'c1', outcome: 'declined' },
    ]);
    pc.service.announceTo('node-Laptop', 'computer-start', { chatId: 'c1', outcome: 'unanswered' });
    pc.service.announceTo('node-Laptop', 'computer-start', { chatId: 'c1', outcome: 'not_started' });
    await expect
      .poll(() => laptop.events.filter((e) => e.type === 'peer-computer-start').map((e) => (e as { outcome: string }).outcome))
      .toEqual(['declined', 'unanswered', 'not_started']);
    await new Promise((r) => setTimeout(r, 50));
    expect(tablet.events.filter((e) => e.type === 'peer-computer-start')).toEqual([]);
  });

  it('drops anything else: an unknown outcome, a missing or overlong chat id, and every other field', async () => {
    const { pc, laptop } = await connected();
    for (const said of [{ chatId: 'c1', outcome: 'exploded' }, { outcome: 'declined' }, { chatId: 'x'.repeat(201), outcome: 'declined' }, null, 'declined']) {
      pc.service.announceTo('node-Laptop', 'computer-start', said);
    }
    pc.service.announceTo('node-Laptop', 'computer-start', { chatId: 'c2', outcome: 'declined', reason: 'the screen said so', app: 'C:\\x.exe' });
    await expect.poll(() => laptop.events.filter((e) => e.type === 'peer-computer-start')).toEqual([
      { type: 'peer-computer-start', nodeId: 'node-PC', chatId: 'c2', outcome: 'declined' },
    ]);
  });
});
