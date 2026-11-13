import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatSendRemote, Handover, HandoverAnswer, Outcome, PeerSendState } from '../../src/chat-sends/remote-port.js';
import { flush, Harness } from './harness.js';

/** Two machines wired to each other's services directly, with a switch for the wire being down. */
class Link implements ChatSendRemote {
  up = true;
  constructor(
    private readonly here: Harness,
    private readonly there: () => Harness,
    private readonly thereId: string,
    private readonly thereName: string
  ) {}
  self(): { id: string; name: string } {
    return this.here.store.nodes.self();
  }
  machineName(nodeId: string): string {
    return nodeId === this.thereId ? this.thereName : nodeId;
  }
  state(): PeerSendState {
    return this.up ? 'ok' : 'unreachable';
  }
  activeChats(): string[] {
    return [];
  }
  async handOver(_nodeId: string, h: Handover): Promise<HandoverAnswer> {
    if (!this.up) return { refused: 'down', final: false };
    return this.there().service.takeHandover(this.self().id, h);
  }
  async report(_nodeId: string, sendId: string, _toChatId: string, o: Outcome): Promise<'taken' | 'retry'> {
    if (!this.up) return 'retry';
    this.there().service.takeOutcome(this.self().id, sendId, o);
    return 'taken';
  }
  async stop(_nodeId: string, sendId: string, _toChatId: string, reason: string): Promise<'taken' | 'retry'> {
    if (!this.up) return 'retry';
    this.there().service.takeStop(this.self().id, sendId, reason);
    return 'taken';
  }
}

let laptop: Harness;
let pc: Harness;
let toPc: Link;
let toLaptop: Link;

const peer = (nodeId: string, name: string) => ({ nodeId, name, fingerprint: nodeId.padEnd(64, 'x'), addresses: [], issuedTokenHash: 'h', heldTokenRef: 'r', platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1 });

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await flush();
    await laptop.service.idle();
    await pc.service.idle();
  }
}

/** The text of the user message a reply answers. */
const askedText = (h: Harness, replyId: string): string =>
  h.store.messages.get(h.store.messages.get(replyId)!.parentId!)!.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

beforeEach(() => {
  laptop = new Harness('node-L');
  pc = new Harness('node-P');
  laptop.store.nodes.rename('Laptop');
  pc.store.nodes.rename('PC');
  laptop.store.peers.create(peer('node-P', 'PC'));
  pc.store.peers.create(peer('node-L', 'Laptop'));
  // Each chat is in both stores, as sync leaves them, running on its own machine.
  laptop.addChat('Finance', { runsOn: 'node-L' });
  laptop.addChat('Budget', { runsOn: 'node-P' });
  pc.addChat('Finance', { runsOn: 'node-L' });
  pc.addChat('Budget', { runsOn: 'node-P' });
  toPc = new Link(laptop, () => pc, 'node-P', 'PC');
  toLaptop = new Link(pc, () => laptop, 'node-L', 'Laptop');
  laptop.build({ remote: toPc }).start();
  pc.build({ remote: toLaptop }).start();
});

afterEach(() => {
  laptop.service.dispose();
  pc.service.dispose();
});

describe('a laptop chat sending to a PC chat', () => {
  it('runs on the PC, and the laptop resumes with its reply', async () => {
    const r = await laptop.reply('Finance');
    await laptop.send('Finance', r, [{ chatId: 'Budget', text: 'Add a runway card.' }]);
    await settle();
    const work = pc.latestReply('Budget')!;
    expect(askedText(pc, work)).toContain('Add a runway card.');
    expect(laptop.latestReply('Budget')).toBeUndefined();
    await laptop.finish(r, 'Sent it.');
    await pc.finish(work, 'Added the runway card.');
    await settle();
    const send = laptop.store.chatSends.byFromMessage(r)[0]!;
    expect(send).toMatchObject({ status: 'replied', replyText: 'Added the runway card.' });
    const resumed = laptop.latestReply('Finance')!;
    expect(resumed).not.toBe(r);
    expect(askedText(laptop, resumed)).toContain('Added the runway card.');
  });

  it('with the PC off at send, the send waits, then goes and comes back once the PC is back', async () => {
    toPc.up = false;
    const r = await laptop.reply('Finance');
    const out = await laptop.send('Finance', r, [{ chatId: 'Budget', text: 'Add a runway card.' }]);
    expect(out).toMatchObject({ sent: [{ held: true, machine: 'PC' }] });
    await laptop.finish(r, 'Waiting for the PC.');
    expect(pc.latestReply('Budget')).toBeUndefined();
    toPc.up = true;
    laptop.service.tick();
    await settle();
    const work = pc.latestReply('Budget')!;
    expect(work).toBeDefined();
    // The PC's answer can't get back while the laptop is off; it is told again on the next tick.
    toLaptop.up = false;
    await pc.finish(work, 'Done.');
    await settle();
    expect(laptop.store.chatSends.byFromMessage(r)[0]!.status).toBe('running');
    toLaptop.up = true;
    pc.service.tick();
    await settle();
    expect(laptop.store.chatSends.byFromMessage(r)[0]!).toMatchObject({ status: 'replied', replyText: 'Done.' });
    expect(laptop.latestReply('Finance')).not.toBe(r);
  });

  it("Stop on the laptop's send card stops the PC's turn, and the laptop stays quiet", async () => {
    const r = await laptop.reply('Finance');
    await laptop.send('Finance', r, [{ chatId: 'Budget', text: 'Add a runway card.' }]);
    await settle();
    const work = pc.latestReply('Budget')!;
    laptop.service.stop(r);
    await settle();
    expect(pc.store.messages.get(work)!.status).toBe('cancelled');
    expect(pc.store.chatSends.byToChat('Budget')[0]!.status).toBe('stopped');
    await laptop.finish(r, 'Sent it.');
    await settle();
    expect(laptop.latestReply('Finance')).toBe(r);
  });
});
