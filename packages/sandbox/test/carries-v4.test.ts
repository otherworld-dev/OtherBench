import { describe, expect, it } from 'vitest';
import { carriesV4 } from './address-sample.js';

const V4 = '168.63.129.16';

describe('carriesV4 (what the live address case holds the runtime-only refusals to)', () => {
  it('accepts the address and the IPv6 forms that carry it', () => {
    for (const text of [V4, '::ffff:168.63.129.16', '::ffff:a83f:8110', '0:0:0:0:0:ffff:a83f:8110', '64:ff9b::a83f:8110', '64:ff9b::168.63.129.16', '64:ff9b:0:0:0:0:a83f:8110', '2002:a83f:8110::', '2002:a83f:8110:1:2:3:4:5']) {
      expect(carriesV4(text, V4), text).toBe(true);
    }
  });

  it('refuses anything else, however close', () => {
    for (const text of ['168.63.129.17', '168.63.129.1', '8.8.8.8', '::ffff:a83f:8111', '::ffff:168.63.129.17', '::a83f:8110', '1::ffff:a83f:8110', '64:ff9b:1::a83f:8110', '2002:a83f:8111::', '2002::a83f:8110', '2606:4700::a83f:8110', '', 'a83f:8110', '::ffff:a83f:8110:1', 'not an address']) {
      expect(carriesV4(text, V4), text).toBe(false);
    }
  });
});
