import {
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_FAILURES,
  generatePairingCode,
} from '@grunt/core/domain/pairing.js';

export interface PairingSession {
  code: string;
  expiresAt: number;
}

export type PairingCheck = 'ok' | 'no-session' | 'wrong-code' | 'cancelled';

/**
 * The one pairing code this machine is showing, if any (v2 spec §3): valid
 * for 10 minutes and one use, and cancelled after five wrong codes. Opening a
 * new one replaces the old.
 */
export class PairingSessions {
  private session: (PairingSession & { failures: number }) | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  open(): PairingSession {
    this.session = { code: generatePairingCode(), expiresAt: this.now() + PAIRING_CODE_TTL_MS, failures: 0 };
    return { code: this.session.code, expiresAt: this.session.expiresAt };
  }

  cancel(): void {
    this.session = null;
  }

  /** The open session, or null once it has expired, been used or been cancelled. */
  current(): PairingSession | null {
    if (this.session && this.now() >= this.session.expiresAt) this.session = null;
    return this.session ? { code: this.session.code, expiresAt: this.session.expiresAt } : null;
  }

  /**
   * Checks an attempt against the open code: `matches(code)` says whether the
   * attempt's MAC was made with it. A match uses the session up; the fifth
   * miss cancels it.
   */
  attempt(matches: (code: string) => boolean): PairingCheck {
    const session = this.current();
    if (!session || !this.session) return 'no-session';
    if (matches(session.code)) {
      this.session = null;
      return 'ok';
    }
    this.session.failures++;
    if (this.session.failures >= PAIRING_MAX_FAILURES) {
      this.session = null;
      return 'cancelled';
    }
    return 'wrong-code';
  }
}
