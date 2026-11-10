import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { START_TIMEOUT_REASON } from '../../src/computer/desktop-driver.js';
import { SHELL_START_DECLINED_REASON, SHELL_START_UNANSWERED_REASON, startOutcomeOf } from '../../src/computer/start-outcome.js';

describe('startOutcomeOf', () => {
  it('names a Cancel, a dialog that closed itself or a shell that never answered, and anything else, never a start', () => {
    expect(startOutcomeOf({ ok: true })).toBeNull();
    expect(startOutcomeOf({ ok: false, reason: SHELL_START_DECLINED_REASON })).toBe('declined');
    expect(startOutcomeOf({ ok: false, reason: SHELL_START_UNANSWERED_REASON })).toBe('unanswered');
    expect(startOutcomeOf({ ok: false, reason: START_TIMEOUT_REASON })).toBe('unanswered');
    expect(startOutcomeOf({ ok: false, reason: 'Another chat is controlling this computer. Stop it first.' })).toBe('not_started');
    expect(startOutcomeOf({ ok: false, reason: `${SHELL_START_DECLINED_REASON} and more` })).toBe('not_started');
  });

  it("matches the shell's own words for the two, as the desktop app sends them", () => {
    const rust = readFileSync(fileURLToPath(new URL('../../../../desktop/src-tauri/src/computer/session.rs', import.meta.url)), 'utf8');
    const said = (name: string): string | undefined => new RegExp(`const ${name}: &str = "((?:[^"\\\\]|\\\\.)*)";`).exec(rust)?.[1];
    expect(said('DECLINED')).toBe(SHELL_START_DECLINED_REASON);
    expect(said('UNANSWERED')).toBe(SHELL_START_UNANSWERED_REASON);
  });
});
