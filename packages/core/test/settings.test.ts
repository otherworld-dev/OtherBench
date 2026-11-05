import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, mayChangePeerComputerControl, peerComputerControlNeedsHostConfirm } from '../src/domain/settings.js';

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
