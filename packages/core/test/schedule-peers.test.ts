import { describe, expect, it } from 'vitest';
import { patchAction } from '../src/domain/schedule-peers.js';
import { DEFAULT_APP_SETTINGS } from '../src/domain/settings.js';

describe('managing schedules from a paired machine', () => {
  it('is off by default', () => {
    expect(DEFAULT_APP_SETTINGS.peerScheduleControl).toBe(false);
  });

  it('records a body that only sets enabled as a pause or a resume, and anything else as an edit', () => {
    expect(patchAction({ enabled: false }, true)).toBe('paused');
    expect(patchAction({ enabled: false }, false)).toBe('paused');
    expect(patchAction({ enabled: true }, false)).toBe('resumed');
    // Already on: nothing was resumed.
    expect(patchAction({ enabled: true }, true)).toBe('edited');
    expect(patchAction({ enabled: false, name: 'x' }, true)).toBe('edited');
    expect(patchAction({ prompt: 'x' }, true)).toBe('edited');
    expect(patchAction({}, true)).toBe('edited');
    expect(patchAction(null, true)).toBe('edited');
    expect(patchAction({ enabled: 'no' }, true)).toBe('edited');
  });
});
