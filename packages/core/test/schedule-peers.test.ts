import { describe, expect, it } from 'vitest';
import { schedulePatchAction, type ScheduleEditedFields } from '../src/domain/schedule-peers.js';
import { DEFAULT_APP_SETTINGS } from '../src/domain/settings.js';

const fields = (over: Partial<ScheduleEditedFields> = {}): ScheduleEditedFields => ({
  name: 'Report', prompt: 'hello', profileId: 'p1', rule: { cadence: 'daily', time: '09:00' }, autoMode: false, timeLimitMinutes: 30, timezone: 'Europe/London', enabled: true, ...over,
});

describe('managing schedules from a paired machine', () => {
  it('is off by default', () => {
    expect(DEFAULT_APP_SETTINGS.peerScheduleControl).toBe(false);
  });

  it('records what actually changed: an edit wins over a pause, a change only to on or off is a pause or resume, nothing is nothing', () => {
    expect(schedulePatchAction(fields(), fields({ enabled: false }))).toBe('paused');
    expect(schedulePatchAction(fields({ enabled: false }), fields())).toBe('resumed');
    for (const over of [{ name: 'x' }, { prompt: 'x' }, { profileId: 'p2' }, { rule: { cadence: 'daily', time: '10:00' } }, { autoMode: true }, { timeLimitMinutes: null }, { timezone: 'America/New_York' }]) {
      expect(schedulePatchAction(fields(), fields(over)), JSON.stringify(over)).toBe('edited');
      // Paused in the same call: still an edit, so it is kept like one.
      expect(schedulePatchAction(fields(), fields({ ...over, enabled: false })), JSON.stringify(over)).toBe('edited');
    }
    expect(schedulePatchAction(fields(), fields())).toBeNull();
    expect(schedulePatchAction(fields({ rule: { cadence: 'daily', time: '09:00' } }), fields())).toBeNull();
  });
});
