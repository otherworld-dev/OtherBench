import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SecretStore } from '../ports/secret-store.js';

/**
 * Shared behavioural contract for every `SecretStore`. Authored once and run
 * UNMODIFIED against `FakeSecretStore` (packages/core/test/fakes.test.ts) and
 * the real `EncryptedFileSecretStore` (packages/store-sqlite/test/
 * secret-store-contract.test.ts), exactly like `runStoreContract`, so the fake
 * cannot drift from the real adapter.
 *
 * Why this exists: the fake was a plain `Map` (atomic), so no test could see
 * that the real file-backed store, being read-modify-write, could lose
 * secrets under concurrent writes. The concurrency cases below are the point.
 *
 * Policy pinned here:
 *   - get() of an unknown ref resolves null (never throws).
 *   - set() overwrites; the last call (in call order) wins.
 *   - delete() of an unknown ref is a no-op (idempotent).
 *   - the empty string is a real value: it round-trips as '' and is NOT
 *     treated as "absent" (a stored empty value is distinguishable from null).
 *   - values are opaque: unicode, newlines and long strings round-trip.
 *   - concurrent set()/delete() calls on one store never lose or resurrect
 *     data: the outcome equals running them one after another in call order.
 */
export function runSecretStoreContract(
  name: string,
  factory: () => SecretStore | Promise<SecretStore>,
  teardown?: (store: SecretStore) => void | Promise<void>
): void {
  describe(`SecretStore contract: ${name}`, () => {
    let secrets: SecretStore;

    beforeEach(async () => {
      secrets = await factory();
    });

    afterEach(async () => {
      if (teardown) await teardown(secrets);
    });

    it('returns null for a ref that was never set', async () => {
      expect(await secrets.get('missing')).toBeNull();
    });

    it('round-trips set -> get', async () => {
      await secrets.set('api-key-1', 'sk-abc123');
      expect(await secrets.get('api-key-1')).toBe('sk-abc123');
    });

    it('keeps refs independent of one another', async () => {
      await secrets.set('a', '1');
      await secrets.set('b', '2');
      expect(await secrets.get('a')).toBe('1');
      expect(await secrets.get('b')).toBe('2');
    });

    it('set overwrites an existing value for the same ref', async () => {
      await secrets.set('ref', 'first');
      await secrets.set('ref', 'second');
      expect(await secrets.get('ref')).toBe('second');
    });

    it('delete removes only the named ref', async () => {
      await secrets.set('a', '1');
      await secrets.set('b', '2');
      await secrets.delete('a');
      expect(await secrets.get('a')).toBeNull();
      expect(await secrets.get('b')).toBe('2');
    });

    it('delete of an unknown ref resolves without throwing, and is idempotent', async () => {
      await expect(secrets.delete('never-set')).resolves.toBeUndefined();
      await secrets.set('x', 'v');
      await secrets.delete('x');
      await expect(secrets.delete('x')).resolves.toBeUndefined();
      expect(await secrets.get('x')).toBeNull();
    });

    it('a ref can be set again after being deleted', async () => {
      await secrets.set('x', 'one');
      await secrets.delete('x');
      await secrets.set('x', 'two');
      expect(await secrets.get('x')).toBe('two');
    });

    it('stores the empty string as a real value, distinct from missing', async () => {
      await secrets.set('empty', '');
      expect(await secrets.get('empty')).toBe('');
      await secrets.delete('empty');
      expect(await secrets.get('empty')).toBeNull();
    });

    it('round-trips unicode, newlines and long values verbatim', async () => {
      const values = ['p\u00e4ssw\u00f6rd \u{1F511} \u65e5\u672c\u8a9e', 'line1\nline2\r\nline3', 'x'.repeat(10_000), '  padded  '];
      for (const [i, v] of values.entries()) {
        await secrets.set(`v${i}`, v);
      }
      for (const [i, v] of values.entries()) {
        expect(await secrets.get(`v${i}`)).toBe(v);
      }
    });

    it('concurrent sets to distinct refs lose nothing', async () => {
      const refs = Array.from({ length: 12 }, (_, i) => `ref-${i}`);
      await Promise.all(refs.map((r) => secrets.set(r, `value-of-${r}`)));
      for (const r of refs) {
        expect(await secrets.get(r)).toBe(`value-of-${r}`);
      }
    });

    it('concurrent sets to the same ref leave the last call\'s value', async () => {
      await Promise.all([1, 2, 3, 4, 5, 6].map((n) => secrets.set('same', `v${n}`)));
      expect(await secrets.get('same')).toBe('v6');
    });

    it('concurrent deletes do not lose data belonging to other refs', async () => {
      const keep = ['keep-0', 'keep-1', 'keep-2'];
      const drop = ['drop-0', 'drop-1', 'drop-2'];
      for (const r of [...keep, ...drop]) await secrets.set(r, `v-${r}`);
      await Promise.all(drop.map((r) => secrets.delete(r)));
      for (const r of drop) expect(await secrets.get(r)).toBeNull();
      for (const r of keep) expect(await secrets.get(r)).toBe(`v-${r}`);
    });

    it('interleaved concurrent sets and deletes behave as if run in call order', async () => {
      await secrets.set('old', 'o');
      await Promise.all([
        secrets.set('a', 'a1'),
        secrets.delete('old'),
        secrets.set('b', 'b1'),
        secrets.set('a', 'a2'),
        secrets.delete('b'),
        secrets.set('c', 'c1'),
        secrets.delete('never-existed'),
      ]);
      expect(await secrets.get('old')).toBeNull();
      expect(await secrets.get('a')).toBe('a2');
      expect(await secrets.get('b')).toBeNull();
      expect(await secrets.get('c')).toBe('c1');
    });
  });
}
