// Authenticode signing of the Windows build with Azure Artifact Signing
// (docs/features/code-signing.md). The pieces CI's `release` job and Tauri's
// `signCommand` (desktop/scripts/release/sign.mjs) share, kept free of I/O so
// they can be tested.
import { join } from 'node:path';

/**
 * What signing needs from the GitHub repository. The secrets are an Entra app
 * registration's credentials, which Microsoft's signing client reads as the
 * AZURE_* environment variables; the variables say which certificate to use.
 * None set: the build is unsigned, as it was before signing existed. All set:
 * it's signed. Some set: a mistake, and the job stops rather than quietly
 * shipping an unsigned build.
 */
export const SIGNING_SETTINGS = /** @type {const} */ ([
  { name: 'ARTIFACT_SIGNING_TENANT_ID', kind: 'secret' },
  { name: 'ARTIFACT_SIGNING_CLIENT_ID', kind: 'secret' },
  { name: 'ARTIFACT_SIGNING_CLIENT_SECRET', kind: 'secret' },
  { name: 'ARTIFACT_SIGNING_ENDPOINT', kind: 'variable' },
  { name: 'ARTIFACT_SIGNING_ACCOUNT', kind: 'variable' },
  { name: 'ARTIFACT_SIGNING_PROFILE', kind: 'variable' },
]);

/**
 * Whether this build is signed, from which settings are present (never their
 * values). Throws, naming what's missing, when only some are.
 * @param {Record<string, boolean>} present
 * @returns {boolean}
 */
export function signingEnabled(present) {
  const missing = SIGNING_SETTINGS.filter((s) => !present[s.name]);
  if (missing.length === SIGNING_SETTINGS.length) return false;
  if (missing.length === 0) return true;
  const list = missing.map((s) => `${s.name} (repository ${s.kind})`).join(', ');
  throw new Error(`Authenticode signing is half set up: ${list} missing. Add them, or remove the others to build unsigned (docs/features/code-signing.md).`);
}

/**
 * Microsoft's signing client: the "dlib" signtool loads to have Artifact
 * Signing sign a file's digest. Pinned, and checked against this hash, so a
 * changed package fails the build instead of signing. Version 1.0.147 on needs
 * the .NET 10 runtime.
 */
export const SIGNING_CLIENT = {
  id: 'Microsoft.ArtifactSigning.Client',
  version: '1.0.151',
  sha256: '35375a4bc4e1102da729fc3d8d9925f774c3baae6b8b7ff6398d948ca9ab0d8a',
  dotnetMajor: 10,
};

/** The NuGet download of `SIGNING_CLIENT`. */
export function signingClientUrl(client = SIGNING_CLIENT) {
  const id = client.id.toLowerCase();
  return `https://api.nuget.org/v3-flatcontainer/${id}/${client.version}/${id}.${client.version}.nupkg`;
}

/** Artifact Signing's RFC 3161 timestamp server. */
export const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com';

/**
 * The account's regional endpoint, refused unless it's one of Artifact
 * Signing's (the client sends credentials there).
 * @param {string} endpoint
 */
export function checkEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new Error(`ARTIFACT_SIGNING_ENDPOINT is not a URL: ${endpoint}`);
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.codesigning.azure.net') || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`ARTIFACT_SIGNING_ENDPOINT must be an Artifact Signing endpoint such as https://neu.codesigning.azure.net, not ${endpoint}`);
  }
  return `https://${url.hostname}`;
}

/**
 * The dlib's metadata.json. Only the environment credential (the AZURE_*
 * variables) and the Azure CLI are left on: on a CI runner nothing else can
 * work, and the interactive ones would wait for a person who isn't there.
 * @param {{ endpoint: string, account: string, profile: string }} settings
 */
export function signingMetadata({ endpoint, account, profile }) {
  return {
    Endpoint: checkEndpoint(endpoint),
    CodeSigningAccountName: account.trim(),
    CertificateProfileName: profile.trim(),
    ExcludeCredentials: [
      'ManagedIdentityCredential',
      'WorkloadIdentityCredential',
      'SharedTokenCacheCredential',
      'VisualStudioCredential',
      'VisualStudioCodeCredential',
      'AzurePowerShellCredential',
      'AzureDeveloperCliCredential',
      'InteractiveBrowserCredential',
    ],
  };
}

/**
 * The x64 signtool.exe of the newest Windows SDK, given the SDK's `bin` folder
 * and what's in it.
 * @param {string} kitsBin e.g. `C:\Program Files (x86)\Windows Kits\10\bin`
 * @param {string[]} entries the folder's entries
 * @param {(path: string) => boolean} exists
 * @returns {string | null}
 */
export function newestSigntool(kitsBin, entries, exists) {
  const versions = entries
    .map((name) => ({ name, parts: /^10\.0\.(\d+)\.(\d+)$/.exec(name) }))
    .filter((v) => v.parts)
    .sort((a, b) => {
      const [, a1, a2] = /** @type {RegExpExecArray} */ (a.parts);
      const [, b1, b2] = /** @type {RegExpExecArray} */ (b.parts);
      return Number(b1) - Number(a1) || Number(b2) - Number(a2);
    });
  for (const v of versions) {
    const path = join(kitsBin, v.name, 'x64', 'signtool.exe');
    if (exists(path)) return path;
  }
  return null;
}

/**
 * signtool's arguments to sign and timestamp one file: SHA-256 for both the
 * file digest and the timestamp, RFC 3161 timestamping. The certificate is
 * Artifact Signing's (`dlib` + `metadata`), or a local .pfx to rehearse with
 * (`pfx`), never both.
 * @param {{ file: string, description: string, timestampUrl: string, dlib?: string, metadata?: string, pfx?: string, pfxPassword?: string }} o
 * @returns {string[]}
 */
export function signtoolSignArgs(o) {
  const args = ['sign', '/v', '/fd', 'SHA256', '/tr', o.timestampUrl, '/td', 'SHA256', '/d', o.description];
  if (o.dlib && o.metadata && !o.pfx) args.push('/dlib', o.dlib, '/dmdf', o.metadata);
  else if (o.pfx && !o.dlib) {
    args.push('/f', o.pfx);
    if (o.pfxPassword) args.push('/p', o.pfxPassword);
  } else throw new Error('Signing needs either the Artifact Signing client (prepare) or a .pfx to rehearse with, and not both');
  args.push(o.file);
  return args;
}

/**
 * What's wrong with the signatures `Get-AuthenticodeSignature` reported, one
 * line per file; none means every file is signed, by a trusted certificate
 * and with a timestamp. A rehearsal with a self-signed .pfx is signed by a
 * certificate Windows doesn't trust (`UnknownError`), which it accepts.
 * @param {{ path: string, status: string, subject: string | null, timestamped: boolean }[]} results
 * @param {{ rehearsal?: boolean }} [options]
 * @returns {string[]}
 */
export function signatureProblems(results, { rehearsal = false } = {}) {
  const accepted = rehearsal ? ['Valid', 'UnknownError'] : ['Valid'];
  return results.flatMap((r) => {
    if (!r.subject || !accepted.includes(r.status)) return [`${r.path}: ${r.status}${r.subject ? ` (signed by ${r.subject})` : ''}`];
    if (!r.timestamped) return [`${r.path}: signed by ${r.subject} but not timestamped`];
    return [];
  });
}

/**
 * The native Node modules (`.node`, DLLs by another name) under `dir`, given a
 * recursive listing of it. Tauri signs a bundled resource only when it's named
 * .exe or .dll, so these are signed by `sign.mjs sign-native` instead.
 * @param {string[]} files paths relative to `dir`
 */
export function nativeModules(files) {
  return files.filter((f) => f.toLowerCase().endsWith('.node'));
}
