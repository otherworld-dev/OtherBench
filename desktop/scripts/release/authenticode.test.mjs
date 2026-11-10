import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  SIGNING_CLIENT, SIGNING_SETTINGS, checkEndpoint, nativeModules, newestSigntool, signatureProblems, signingClientUrl, signingEnabled,
  signingMetadata, signtoolSignArgs,
} from './authenticode.mjs';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {boolean} value */
const all = (value) => Object.fromEntries(SIGNING_SETTINGS.map((s) => [s.name, value]));

describe('signingEnabled', () => {
  test('with no settings the build is unsigned, as it was before signing existed', () => {
    expect(signingEnabled(all(false))).toBe(false);
    expect(signingEnabled({})).toBe(false);
  });

  test('with every setting it is signed', () => {
    expect(signingEnabled(all(true))).toBe(true);
  });

  test('with some but not all it stops, naming only what is missing', () => {
    const present = { ...all(true), ARTIFACT_SIGNING_CLIENT_SECRET: false, ARTIFACT_SIGNING_PROFILE: false };
    expect(() => signingEnabled(present)).toThrow(/ARTIFACT_SIGNING_CLIENT_SECRET \(repository secret\), ARTIFACT_SIGNING_PROFILE \(repository variable\) missing/);
    expect(() => signingEnabled(present)).not.toThrow(/ARTIFACT_SIGNING_TENANT_ID/);
  });
});

describe('checkEndpoint', () => {
  test('takes an Artifact Signing regional endpoint, with or without a trailing slash', () => {
    expect(checkEndpoint('https://neu.codesigning.azure.net')).toBe('https://neu.codesigning.azure.net');
    expect(checkEndpoint(' https://weu.codesigning.azure.net/ ')).toBe('https://weu.codesigning.azure.net');
  });

  test('refuses anything else, since the client sends credentials there', () => {
    for (const bad of ['http://neu.codesigning.azure.net', 'https://neu.codesigning.azure.net.evil.example', 'https://example.com', 'neu', 'https://neu.codesigning.azure.net/x']) {
      expect(() => checkEndpoint(bad), bad).toThrow(/ARTIFACT_SIGNING_ENDPOINT/);
    }
  });
});

test('the metadata names the account and profile and leaves only credentials a runner can use', () => {
  const m = signingMetadata({ endpoint: 'https://neu.codesigning.azure.net/', account: ' otherworld ', profile: 'otherbench' });
  expect(m).toMatchObject({ Endpoint: 'https://neu.codesigning.azure.net', CodeSigningAccountName: 'otherworld', CertificateProfileName: 'otherbench' });
  expect(m.ExcludeCredentials).toContain('InteractiveBrowserCredential');
  expect(m.ExcludeCredentials).not.toContain('EnvironmentCredential');
});

test('the signing client is a pinned NuGet package', () => {
  expect(signingClientUrl()).toBe(`https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/${SIGNING_CLIENT.version}/microsoft.artifactsigning.client.${SIGNING_CLIENT.version}.nupkg`);
  expect(SIGNING_CLIENT.sha256).toMatch(/^[0-9a-f]{64}$/);
});

describe('newestSigntool', () => {
  const bin = 'C:\\Kits\\bin';
  test('picks the newest SDK that has an x64 signtool, comparing versions as numbers', () => {
    const have = new Set([join(bin, '10.0.9600.0', 'x64', 'signtool.exe'), join(bin, '10.0.26100.0', 'x64', 'signtool.exe'), join(bin, '10.0.22621.0', 'x64', 'signtool.exe')]);
    expect(newestSigntool(bin, ['10.0.9600.0', 'x64', '10.0.26100.0', '10.0.22621.0'], (p) => have.has(p))).toBe(join(bin, '10.0.26100.0', 'x64', 'signtool.exe'));
  });

  test('skips an SDK folder without one, and finds none in an empty folder', () => {
    const have = new Set([join(bin, '10.0.22621.0', 'x64', 'signtool.exe')]);
    expect(newestSigntool(bin, ['10.0.26100.0', '10.0.22621.0'], (p) => have.has(p))).toBe(join(bin, '10.0.22621.0', 'x64', 'signtool.exe'));
    expect(newestSigntool(bin, [], () => true)).toBeNull();
  });
});

describe('signtoolSignArgs', () => {
  const base = { file: 'C:\\b\\OtherBench_0.2.0_x64-setup.exe', description: 'OtherBench', timestampUrl: 'http://timestamp.acs.microsoft.com' };

  test('signs with Artifact Signing, SHA-256 digests and an RFC 3161 timestamp, the file last', () => {
    const args = signtoolSignArgs({ ...base, dlib: 'D.dll', metadata: 'm.json' });
    expect(args).toEqual(['sign', '/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256', '/d', 'OtherBench', '/dlib', 'D.dll', '/dmdf', 'm.json', base.file]);
  });

  test('or with a local .pfx to rehearse with', () => {
    expect(signtoolSignArgs({ ...base, pfx: 't.pfx', pfxPassword: 'pw' }).slice(-5)).toEqual(['/f', 't.pfx', '/p', 'pw', base.file]);
  });

  test('refuses neither or both', () => {
    expect(() => signtoolSignArgs(base)).toThrow(/either/);
    expect(() => signtoolSignArgs({ ...base, dlib: 'D.dll', metadata: 'm.json', pfx: 't.pfx' })).toThrow(/either/);
  });
});

describe('signatureProblems', () => {
  const good = { path: 'a.exe', status: 'Valid', subject: 'CN=Otherworld Ltd', timestamped: true };

  test('a trusted, timestamped signature on every file passes', () => {
    expect(signatureProblems([good, { ...good, path: 'b.node' }])).toEqual([]);
  });

  test('unsigned, untrusted, tampered or untimestamped files are each named', () => {
    const problems = signatureProblems([
      good,
      { path: 'unsigned.exe', status: 'NotSigned', subject: null, timestamped: false },
      { path: 'selfsigned.exe', status: 'UnknownError', subject: 'CN=test', timestamped: true },
      { path: 'changed.exe', status: 'HashMismatch', subject: 'CN=Otherworld Ltd', timestamped: true },
      { path: 'nots.exe', status: 'Valid', subject: 'CN=Otherworld Ltd', timestamped: false },
    ]);
    expect(problems).toEqual([
      'unsigned.exe: NotSigned',
      'selfsigned.exe: UnknownError (signed by CN=test)',
      'changed.exe: HashMismatch (signed by CN=Otherworld Ltd)',
      'nots.exe: signed by CN=Otherworld Ltd but not timestamped',
    ]);
  });

  test('a rehearsal accepts its self-signed certificate, but still needs a timestamp', () => {
    const rehearsal = { path: 'r.exe', status: 'UnknownError', subject: 'CN=test', timestamped: true };
    expect(signatureProblems([rehearsal], { rehearsal: true })).toEqual([]);
    expect(signatureProblems([{ ...rehearsal, timestamped: false }], { rehearsal: true })).toHaveLength(1);
    expect(signatureProblems([{ path: 'u.exe', status: 'NotSigned', subject: null, timestamped: false }], { rehearsal: true })).toHaveLength(1);
  });
});

test('native modules are the .node files, whatever their case', () => {
  expect(nativeModules(['server\\a\\conpty.node', 'server\\a\\conpty.pdb', 'node\\node.exe', 'x\\Y.NODE'])).toEqual(['server\\a\\conpty.node', 'x\\Y.NODE']);
});

test('the signing overlay sets signCommand to sign.mjs and changes nothing else Tauri signs with', () => {
  const conf = JSON.parse(readFileSync(join(desktopDir, 'src-tauri', 'tauri.authenticode.conf.json'), 'utf8'));
  expect(conf.bundle.windows.signCommand).toEqual({ cmd: 'node', args: ['../scripts/release/sign.mjs', 'sign', '%1'] });
  expect(conf.build.beforeBundleCommand).toBe('node scripts/release/sign.mjs sign-native');
  expect(Object.keys(conf.bundle)).toEqual(['windows']);
  expect(conf.plugins).toBeUndefined();
});
