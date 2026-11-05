import { describe, expect, it } from 'vitest';
import { PeerInfluence } from '../../src/peer/forward.js';

const idle = (): boolean => true;
const busy = (): boolean => false;

describe('PeerInfluence', () => {
  it('keeps the mark while a second, overlapping write is still being handled after the first finished early', () => {
    const influence = new PeerInfluence();
    const first = influence.touch('c1', 'node-laptop');
    const second = influence.touch('c1', 'node-laptop');
    // The first write is done and the chat looks idle: the second still holds it.
    first();
    influence.settleIfIdle('c1', idle);
    expect(influence.of('c1')).toBe('node-laptop');
    // Releasing the first again changes nothing.
    first();
    influence.settleIfIdle('c1', idle);
    expect(influence.of('c1')).toBe('node-laptop');
    second();
    influence.settleIfIdle('c1', idle);
    expect(influence.of('c1')).toBeNull();
  });

  it('keeps the mark while the chat is busy, whatever holds it, and drops it only when idle with nothing held', () => {
    const influence = new PeerInfluence();
    influence.touch('c1', 'node-laptop')();
    influence.settleIfIdle('c1', busy);
    expect(influence.of('c1')).toBe('node-laptop');
    influence.settleIfIdle('c1', idle);
    expect(influence.of('c1')).toBeNull();
  });

  it("marks a self-started turn that carries on a reply the paired machine's input reached, even after the chat went quiet", () => {
    const influence = new PeerInfluence();
    // A reply running when the laptop wrote, and one started while the chat was marked.
    const release = influence.touch('c1', 'node-laptop', ['r1']);
    influence.started('c1', ['r2']);
    release();
    influence.settleIfIdle('c1', idle);
    expect(influence.of('c1')).toBeNull();

    for (const after of ['r1', 'r2']) {
      const held = influence.inherit('c1', after);
      expect(influence.of('c1')).toBe('node-laptop');
      // Until the turn is running (or declined), nothing drops it.
      influence.settleIfIdle('c1', idle);
      expect(influence.of('c1')).toBe('node-laptop');
      held();
      influence.settleIfIdle('c1', idle);
      expect(influence.of('c1')).toBeNull();
    }
  });

  it("leaves a self-started turn after this machine's own reply unmarked", () => {
    const influence = new PeerInfluence();
    influence.started('c1', ['own']);
    influence.inherit('c1', 'own')();
    expect(influence.of('c1')).toBeNull();
  });

  it('a self-start in a chat that is marked now holds the mark too', () => {
    const influence = new PeerInfluence();
    const write = influence.touch('c1', 'node-laptop');
    const turn = influence.inherit('c1', 'unknown-reply');
    write();
    influence.settleIfIdle('c1', idle);
    expect(influence.of('c1')).toBe('node-laptop');
    turn();
    influence.settleIfIdle('c1', idle);
    expect(influence.of('c1')).toBeNull();
  });
});
