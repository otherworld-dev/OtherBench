import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, fillStartCommand, mayChangePeerComputerControl, peerComputerControlNeedsHostConfirm } from '../src/domain/settings.js';

describe('peerComputerControl', () => {
  it('is off by default', () => {
    expect(DEFAULT_APP_SETTINGS.peerComputerControl).toBe(false);
  });

  it("needs the person here to confirm it only when it's being turned on", () => {
    expect(peerComputerControlNeedsHostConfirm(false, true)).toBe(true);
    expect(peerComputerControlNeedsHostConfirm(true, true)).toBe(false);
    expect(peerComputerControlNeedsHostConfirm(true, false)).toBe(false);
    expect(peerComputerControlNeedsHostConfirm(false, false)).toBe(false);
  });

  it('is turned on only from the desktop app, and turned off or left as it is from anywhere', () => {
    expect(mayChangePeerComputerControl(false, true, true)).toBe(true);
    expect(mayChangePeerComputerControl(false, true, false)).toBe(false);
    expect(mayChangePeerComputerControl(true, false, false)).toBe(true);
    expect(mayChangePeerComputerControl(true, false, true)).toBe(true);
    expect(mayChangePeerComputerControl(true, true, false)).toBe(true);
    expect(mayChangePeerComputerControl(false, false, false)).toBe(true);
  });
});

describe('fillStartCommand', () => {
  it('is null when no command is set, so the Chat button pre-fills instead', () => {
    expect(DEFAULT_APP_SETTINGS.deckStartCommand).toBe('');
    expect(DEFAULT_APP_SETTINGS.issueStartCommand).toBe('');
    expect(fillStartCommand('', '{card}', 'd123')).toBeNull();
    expect(fillStartCommand('   ', '{card}', 'd123')).toBeNull();
  });

  it('puts the ref where the placeholder is, every time it appears', () => {
    expect(fillStartCommand('/start {card}', '{card}', 'd123')).toBe('/start d123');
    expect(fillStartCommand(' /work {issue} then close {issue} ', '{issue}', '#45')).toBe('/work #45 then close #45');
  });

  it('adds the ref on the end when the command has no placeholder', () => {
    expect(fillStartCommand('/start', '{card}', 'd123')).toBe('/start d123');
    expect(fillStartCommand('/start {issue}', '{card}', 'd123')).toBe('/start {issue} d123');
  });
});
