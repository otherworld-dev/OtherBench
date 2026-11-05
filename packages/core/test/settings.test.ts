import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, mayChangePeerComputerControl } from '../src/domain/settings.js';

describe('peerComputerControl', () => {
  it('is off by default', () => {
    expect(DEFAULT_APP_SETTINGS.peerComputerControl).toBe(false);
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
