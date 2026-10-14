import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

/** The body of `async function <name>(` up to the next line that is just `}`. */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end);
}

describe('one way to check the sign-in password', () => {
  it('has verifyPassword used only by checkPassword in remote/auth.ts, which takes the limiter first', () => {
    const users = sources(src)
      .filter((file) => /\bverifyPassword\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(src, file).replaceAll('\\', '/'))
      .sort();
    expect(users).toEqual(['remote/auth.ts', 'remote/password.ts']);

    const auth = readFileSync(join(src, 'remote', 'auth.ts'), 'utf8');
    const calls = [...auth.matchAll(/\bverifyPassword\(/g)];
    expect(calls).toHaveLength(1);
    const body = functionBody(auth, 'checkPassword');
    expect(body).toContain('verifyPassword(');
    // The limiter is asked before the password file is read or scrypt runs.
    const admit = body.indexOf('remote.limiter.admit(');
    expect(admit).toBeGreaterThan(0);
    expect(body.indexOf('remote.passwords.read()')).toBeGreaterThan(admit);
    expect(body.indexOf('verifyPassword(')).toBeGreaterThan(admit);
    expect(auth.split('remote.passwords.read()').length - 1).toBe(1);
  });

  it('has checkPassword called only by the sign-in and change-password routes', () => {
    const auth = readFileSync(join(src, 'remote', 'auth.ts'), 'utf8');
    const calls = [...auth.matchAll(/await checkPassword\(c, remote, address, (\w+), (\d+)\)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(calls).toEqual(['password 401', 'current 403']);
    for (const file of sources(src)) {
      if (file.endsWith(join('remote', 'auth.ts'))) continue;
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bcheckPassword\b/);
    }
  });
});
