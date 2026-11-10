// Authenticode signing for CI's release job (docs/features/code-signing.md):
//
//   node desktop/scripts/release/sign.mjs enabled       whether this build is signed (GITHUB_OUTPUT enabled=true|false)
//   node desktop/scripts/release/sign.mjs prepare       fetches Microsoft's signing client and writes its metadata.json
//   node desktop/scripts/release/sign.mjs sign <file>   signs one file: Tauri's bundle.windows.signCommand
//   node desktop/scripts/release/sign.mjs sign-native   signs the bundled native Node modules: build.beforeBundleCommand
//   node desktop/scripts/release/sign.mjs verify        checks the built installer and what it carries are signed and timestamped
//
// `sign` and `sign-native` run only through src-tauri/tauri.authenticode.conf.json,
// which the release job adds to `tauri build` when signing is enabled.
// Tauri calls `sign` for the app's exe, the NSIS plugins, the uninstaller and
// the installer, and for bundled resources named .exe or .dll that aren't
// signed already (node.exe and claude.exe come signed by their publishers),
// all before it writes the updater's .sig, so that covers the signed installer.
// Tauri puts the app's exe back unsigned in target/release once it has been
// packed, so `verify` checks the copy inside the installer (7-Zip reads NSIS).
//
// Nothing here prints a secret: the AZURE_* credentials reach Microsoft's
// client through the environment, and signtool's arguments hold none.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIGNING_CLIENT, SIGNING_SETTINGS, TIMESTAMP_URL, nativeModules, newestSigntool, signatureProblems, signingClientUrl,
  signingEnabled, signingMetadata, signtoolSignArgs,
} from './authenticode.mjs';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundleResources = join(desktopDir, 'src-tauri', 'bundle-resources');
const nsisDir = join(desktopDir, 'src-tauri', 'target', 'release', 'bundle', 'nsis');

/** @param {string} name */
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Appends `NAME=value` to a GitHub file command, or prints it when run locally.
 * @param {'GITHUB_OUTPUT' | 'GITHUB_ENV'} variable @param {string} line
 */
function githubFile(variable, line) {
  const file = process.env[variable];
  if (file) appendFileSync(file, `${line}\n`);
  else console.log(line);
}

// Reads HAS_<setting>=true|false, which the workflow sets from
// `secrets.X != ''` / `vars.X != ''`: the values never reach this process.
function enabled() {
  /** @type {Record<string, boolean>} */
  const present = {};
  for (const s of SIGNING_SETTINGS) present[s.name] = process.env[`HAS_${s.name}`] === 'true';
  const on = signingEnabled(present);
  console.log(on ? 'Authenticode signing is on.' : 'Authenticode signing is off: no Artifact Signing settings in this repository, so the build is unsigned.');
  githubFile('GITHUB_OUTPUT', `enabled=${on}`);
}

function signtool() {
  const preset = process.env.OTHERBENCH_SIGNTOOL;
  if (preset) return preset;
  const kitsBin = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const found = existsSync(kitsBin) ? newestSigntool(kitsBin, readdirSync(kitsBin), existsSync) : null;
  if (!found) throw new Error(`No x64 signtool.exe under ${kitsBin}: install the Windows SDK`);
  return found;
}

async function prepare() {
  const metadata = signingMetadata({
    endpoint: env('ARTIFACT_SIGNING_ENDPOINT'),
    account: env('ARTIFACT_SIGNING_ACCOUNT'),
    profile: env('ARTIFACT_SIGNING_PROFILE'),
  });

  const runtimes = spawnSync('dotnet', ['--list-runtimes'], { encoding: 'utf8' });
  const major = SIGNING_CLIENT.dotnetMajor;
  if (!new RegExp(`^Microsoft\\.NETCore\\.App ${major}\\.`, 'm').test(runtimes.stdout ?? '')) {
    throw new Error(`The signing client needs the .NET ${major} runtime (Microsoft.NETCore.App ${major}.x), and dotnet lists none`);
  }

  const work = join(process.env.RUNNER_TEMP || tmpdir(), 'otherbench-authenticode');
  mkdirSync(work, { recursive: true });
  const nupkg = join(work, `${SIGNING_CLIENT.id}.${SIGNING_CLIENT.version}.nupkg`);
  const response = await fetch(signingClientUrl());
  if (!response.ok) throw new Error(`Downloading ${SIGNING_CLIENT.id} ${SIGNING_CLIENT.version} failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== SIGNING_CLIENT.sha256) {
    throw new Error(`${SIGNING_CLIENT.id} ${SIGNING_CLIENT.version} has SHA-256 ${hash}, not the pinned ${SIGNING_CLIENT.sha256}`);
  }
  writeFileSync(nupkg, bytes);
  const client = join(work, 'client');
  mkdirSync(client, { recursive: true });
  // Windows' own tar reads zip; Git's GNU tar, which can come first on PATH, doesn't.
  execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', nupkg, '-C', client], { stdio: 'inherit' });
  const dlib = join(client, 'bin', 'x64', 'Azure.CodeSigning.Dlib.dll');
  if (!existsSync(dlib)) throw new Error(`${dlib} is missing from ${SIGNING_CLIENT.id} ${SIGNING_CLIENT.version}`);

  const metadataFile = join(work, 'metadata.json');
  writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
  const tool = signtool();
  console.log(`[sign] ${SIGNING_CLIENT.id} ${SIGNING_CLIENT.version} in ${client}; signtool ${tool}; account ${metadata.CodeSigningAccountName}, profile ${metadata.CertificateProfileName} at ${metadata.Endpoint}`);
  githubFile('GITHUB_ENV', `OTHERBENCH_SIGNTOOL=${tool}`);
  githubFile('GITHUB_ENV', `OTHERBENCH_SIGN_DLIB=${dlib}`);
  githubFile('GITHUB_ENV', `OTHERBENCH_SIGN_METADATA=${metadataFile}`);
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Signs and timestamps `file` in place, trying three times: the signing
 * service and the timestamp server each fail now and then.
 * @param {string} file
 */
async function signFile(file) {
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const pfx = process.env.OTHERBENCH_SIGN_PFX;
  const args = signtoolSignArgs({
    file,
    description: 'OtherBench',
    timestampUrl: process.env.OTHERBENCH_SIGN_TIMESTAMP_URL || TIMESTAMP_URL,
    ...(pfx
      ? { pfx, pfxPassword: process.env.OTHERBENCH_SIGN_PFX_PASSWORD }
      : { dlib: env('OTHERBENCH_SIGN_DLIB'), metadata: env('OTHERBENCH_SIGN_METADATA') }),
  });
  const tool = signtool();
  for (let attempt = 1; ; attempt++) {
    const run = spawnSync(tool, args, { encoding: 'utf8' });
    if (run.status === 0) {
      console.log(`[sign] signed ${file}`);
      return;
    }
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}`.trim();
    if (attempt === 3) throw new Error(`signtool failed to sign ${file} (exit ${run.status}):\n${output}`);
    console.error(`[sign] attempt ${attempt} to sign ${file} failed (exit ${run.status}), trying again:\n${output}`);
    await sleep(attempt * 10_000);
  }
}

/** @param {string} file */
function alreadySigned(file) {
  return spawnSync(signtool(), ['verify', '/pa', '/q', file]).status === 0;
}

async function signNative() {
  if (!existsSync(bundleResources)) throw new Error(`${bundleResources} is missing: stage.mjs runs before the build`);
  const files = nativeModules(/** @type {string[]} */ (readdirSync(bundleResources, { recursive: true, encoding: 'utf8' })));
  for (const f of files) {
    const path = join(bundleResources, f);
    if (alreadySigned(path)) console.log(`[sign] ${f} is signed by its publisher already`);
    else await signFile(path);
  }
}

/**
 * `Get-AuthenticodeSignature` for each file.
 * @param {string[]} files
 * @returns {{ path: string, status: string, subject: string | null, timestamped: boolean }[]}
 */
function authenticodeSignatures(files) {
  // Windows PowerShell rather than pwsh, so it runs on any Windows machine.
  const script = 'ConvertTo-Json -InputObject @($input | Where-Object { $_ } | ForEach-Object { $s = Get-AuthenticodeSignature -LiteralPath $_; [pscustomobject]@{ path = $_; status = [string]$s.Status; subject = $s.SignerCertificate.Subject; timestamped = [bool]$s.TimeStamperCertificate } })';
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { input: files.join('\n'), encoding: 'utf8' });
  return JSON.parse(out);
}

// The installer, and the app and native modules packed inside it. The
// uninstaller is written at install time, so it can only be checked on an
// installed copy; Tauri signs it with the same command.
function verify(rehearsal = false) {
  const installers = readdirSync(nsisDir).filter((f) => f.endsWith('-setup.exe'));
  if (installers.length !== 1) throw new Error(`Expected one installer in ${nsisDir}, found ${installers.length}`);
  const installer = join(nsisDir, /** @type {string} */ (installers[0]));
  const out = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'otherbench-verify-'));
  const sevenZip = join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe');
  execFileSync(sevenZip, ['e', '-y', `-o${out}`, installer, 'otherbench-desktop.exe', '*.node', '-r'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const packed = readdirSync(out).map((f) => join(out, f));
  if (!packed.some((f) => f.endsWith('otherbench-desktop.exe'))) throw new Error(`otherbench-desktop.exe is not in ${installer}`);
  const results = authenticodeSignatures([installer, ...packed]);
  for (const r of results) console.log(`[sign] ${r.path}: ${r.status}, ${r.subject ?? 'no signer'}${r.timestamped ? ', timestamped' : ''}`);
  const problems = signatureProblems(results, { rehearsal });
  if (problems.length) throw new Error(`Not properly signed:\n${problems.join('\n')}`);
}

const [command, arg] = process.argv.slice(2);
if (command === 'enabled') enabled();
else if (command === 'prepare') await prepare();
else if (command === 'sign' && arg) await signFile(arg);
else if (command === 'sign-native') await signNative();
else if (command === 'verify') verify(arg === '--rehearsal');
else throw new Error('Usage: sign.mjs enabled | prepare | sign <file> | sign-native | verify [--rehearsal]');
