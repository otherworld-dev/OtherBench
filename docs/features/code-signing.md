# Code signing (Authenticode)

Deck d778. Windows SmartScreen warns on the first install of an unsigned
installer, and until now the only signature on a release was the updater's
own (minisign, see [Updates](updates.md)), which Windows knows nothing about.
CI's `release` job can now Authenticode sign every build with Azure Artifact
Signing (Microsoft's managed signing service, called Trusted Signing until
2025). It is wired in and tested as far as it can be without a certificate,
and it stays off until the repository has the settings below; until then
betas and releases are built and published unsigned, exactly as before.

## The route, and why

| Option | Cost | Works from a GitHub-hosted runner | Notes |
| --- | --- | --- | --- |
| **Azure Artifact Signing** (chosen) | US$9.99 a month (Basic: 5,000 signatures, then US$0.005 each) | Yes, the key never leaves Microsoft's HSMs and the runner authenticates with an Entra app registration | Open to organisations in the UK, EU, USA, Canada and a few others; individuals only in the USA and Canada |
| OV certificate from a CA | about US$150 to US$300 a year, plus a cloud HSM service | Only through the CA's cloud HSM (DigiCert KeyLocker, SSL.com eSigner and similar), often charged per signature | Since June 2023 the CA/Browser Forum rules require OV and EV keys to be generated and kept on hardware, so a `.pfx` in a GitHub secret is no longer possible |
| EV certificate | US$400 a year and up | As OV | Since 2024 EV no longer skips SmartScreen's reputation check, so it buys nothing here |

Artifact Signing is the cheapest route that signs from the hosted runner,
and it is the one Tauri documents. Its certificates are short lived (three
days) and Microsoft issues new ones itself, so there is nothing to renew by
hand, and SmartScreen reputation is built against the validated identity
(Otherworld's name) rather than any one certificate.

Signing happens inside `tauri build`, through Tauri's
`bundle.windows.signCommand`, rather than with Microsoft's Artifact Signing
GitHub Action after the build. The action can only sign
files that already exist, so it cannot sign the app inside the installer,
and re-signing the installer after Tauri has written the updater's `.sig`
would change its bytes and break that signature. Signing through Tauri also
signs the uninstaller, which Tauri builds and signs part way through making
the installer.

## What gets signed

The order below is what a rehearsal build (see the end of this page) logged,
with `desktop/scripts/release/sign.mjs` doing the signing each time:

1. `build.beforeBundleCommand` runs `sign.mjs sign-native`, which signs the
   native Node modules in the server bundle (node-pty's `conpty.node` and
   `conpty_console_list.node`). They are DLLs, but Tauri only signs
   resources named `.exe` or `.dll`, so it would skip them.
2. Tauri's `signCommand` (`sign.mjs sign <file>`) signs the app itself,
   `target/release/otherbench-desktop.exe` (installed as `OtherBench.exe`).
3. It checks the bundled `.exe` and `.dll` resources and signs any that are
   not signed already. The Node runtime (`node/node.exe`) is copied from the
   runner's own Node, which the OpenJS Foundation signs, and the Claude Code
   binary (`claude.exe`) is signed by Anthropic, so both are left alone.
4. It signs the five NSIS plugin DLLs the installer carries (`System.dll`,
   `nsDialogs.dll`, `StartMenu.dll`, `NSISdl.dll`, `nsis_tauri_utils.dll`).
5. NSIS signs the uninstaller as it writes it, using the same command.
6. Tauri signs the installer, `OtherBench_<version>_x64-setup.exe`.
7. Only then does Tauri write the updater signature
   (`OtherBench_<version>_x64-setup.exe.sig`), so the `.sig` and
   `latest.json` cover the signed installer. Installed apps check that
   signature as before, and the updater key and its public half in
   `tauri.conf.json` are unchanged.

SmartScreen itself only checks the downloaded installer, as that is the only
file carrying the download mark, however Smart App Control and some
antivirus products check every binary that runs, so everything that ships
is signed.

Every file is signed with SHA-256 and timestamped (see below). After the
build, `sign.mjs verify` checks the installer, and the app and native
modules packed inside it (extracted with 7-Zip, which the runner has), with
`Get-AuthenticodeSignature`, and stops the job before publishing if any is
not `Valid` or has no timestamp. It checks the packed copy because Tauri
puts the unsigned `target/release/otherbench-desktop.exe` back once the
installer is built, so the file left in `target/release` is never the one
that shipped.

## How it is switched on

The `release` job's first step after setting up Node,
`sign.mjs enabled`, looks at which of these repository settings exist (it
is passed only whether each one is set, never its value):

| Name | Kind | Value |
| --- | --- | --- |
| `ARTIFACT_SIGNING_TENANT_ID` | secret | The Directory (tenant) ID of the app registration |
| `ARTIFACT_SIGNING_CLIENT_ID` | secret | The Application (client) ID of the app registration |
| `ARTIFACT_SIGNING_CLIENT_SECRET` | secret | The app registration's client secret (its value, not its ID) |
| `ARTIFACT_SIGNING_ENDPOINT` | variable | The account's regional endpoint, for example `https://neu.codesigning.azure.net` for North Europe |
| `ARTIFACT_SIGNING_ACCOUNT` | variable | The Artifact Signing account name |
| `ARTIFACT_SIGNING_PROFILE` | variable | The certificate profile name |

- **None set:** signing is off and the build runs the same
  `npm run app:release` it always has.
- **All set:** the job installs the .NET 10 runtime (Microsoft's signing
  client runs on it), runs `sign.mjs prepare`, which downloads the client
  (`Microsoft.ArtifactSigning.Client`, pinned to a version and checked
  against its SHA-256) and writes its `metadata.json`, then builds with
  `src-tauri/tauri.authenticode.conf.json` added. Only that build step
  gets the three secrets, as the `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and
  `AZURE_CLIENT_SECRET` the client reads.
- **Some set:** the job stops straight away and names what is missing, so
  a half-finished setup cannot quietly publish an unsigned build.

The account, profile and endpoint are variables rather than secrets as
they are not sensitive and are useful to see in the job log. Removing all
six turns signing off again.

The app registration uses a client secret rather than GitHub's OIDC
federation. With OIDC the Azure login happens at the start of the job and
rests on a GitHub token that is only valid for a few minutes, whereas the
signing client asks for its own access token at the end of the build, 20
minutes or more later, which is a known way for federated logins to fail.
OIDC would remove the long-lived secret, so it is worth revisiting if the
signing client gains a way to take a token from the job directly.

## What you need to do (Adam)

This only needs doing once, apart from renewing the client secret.

1. **Check the company records.** Microsoft validates the organisation
   against public records, so Otherworld's legal name and registered
   address at Companies House, its website and the email domain used for
   the request all need to agree. Microsoft does not publish a minimum
   company age, however a UK company incorporated a week before applying
   was reported as failing validation with no reason given, and a failed
   attempt cannot be edited, only replaced.
2. **Azure subscription.** In the Azure portal (with a pay-as-you-go
   subscription), go to Subscriptions → *the subscription* → Resource
   providers and register `Microsoft.CodeSigning`.
3. **Create the Artifact Signing account.** Search the portal for
   *Artifact Signing Accounts* → Create. Pick a resource group, a name
   (3 to 24 letters and digits, globally unique, for example
   `otherworldsigning`), the region **North Europe** or **West Europe**
   (the endpoint is then `https://neu.codesigning.azure.net` or
   `https://weu.codesigning.azure.net`), and the **Basic** tier.
4. **Give yourself the Identity Verifier role.** On the account,
   Access control (IAM) → Add role assignment → *Artifact Signing Identity
   Verifier* → yourself. Without it the *New identity* button is greyed out.
5. **Request the identity validation.** On the account, Identity
   validations → Organization → New identity → **Public**. Fill in the
   legal name, website, a primary email on the company's domain (a real
   mailbox, the verification link expires after 7 days), a different
   secondary email on the same domain, the company number as the business
   identifier, the registered address, and your name exactly as on your
   passport or driving licence. When the status changes to *Action
   Required*, follow the link to verify yourself as the individual
   (AU10TIX, using your phone and Microsoft Authenticator). Microsoft
   quotes 1 to 20 business days, and may ask for documents dated within
   the last 12 months (for example the Companies House certificate, and a
   domain registration or renewal invoice naming the company).
6. **Create the certificate profile** once the validation is *Completed*:
   on the account, Certificate profiles → Create → **Public Trust**, give it
   a name (5 to 100 letters and digits, for example `otherbench`) and
   select the validation. Leave out the street address unless you want it
   in the certificate.
7. **Create the app registration CI signs as.** Microsoft Entra ID → App
   registrations → New registration (for example
   `otherbench-github-signing`, single tenant, no redirect URI). Note its
   Application (client) ID and Directory (tenant) ID. Under Certificates &
   secrets → New client secret, choose an expiry (24 months at most) and
   copy the secret's **Value** straight away, it is only shown once.
8. **Let it sign with the profile, and nothing else.** On the certificate
   profile (or the account), Access control (IAM) → Add role assignment →
   *Artifact Signing Certificate Profile Signer* → the app registration.
   It needs no other role.
9. **Add the settings to GitHub.** In `otherworld-dev/OtherBench`, Settings
   → Secrets and variables → Actions. Under *Secrets*, add
   `ARTIFACT_SIGNING_TENANT_ID`, `ARTIFACT_SIGNING_CLIENT_ID` and
   `ARTIFACT_SIGNING_CLIENT_SECRET`. Under *Variables*, add
   `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT` and
   `ARTIFACT_SIGNING_PROFILE`. Repository-level secrets are fine, as only
   pushes to `dev` and `v*` tags run the release job.
10. **Push `dev`** (or re-run the last release job) and check the result as
    below. Put a reminder in the calendar a fortnight before the client
    secret expires, and when it does, create a new one and replace
    `ARTIFACT_SIGNING_CLIENT_SECRET`.

**Cost.** The Basic tier is US$9.99 a month, billed to the Azure
subscription, for up to 5,000 signatures and one Public Trust profile. A
build makes ten signatures (the app, five NSIS plugins, two native
modules, the uninstaller and the installer), so even a few hundred betas a
month stay inside the allowance. The identity validation itself is free.

## Checking a signed build

On any Windows machine, in PowerShell, after downloading the installer from
the GitHub release:

```powershell
Get-AuthenticodeSignature .\OtherBench_0.2.1_x64-setup.exe | Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

`Status` should be `Valid`, `SignerCertificate` should name Otherworld (the
issuer is a *Microsoft ID Verified CS* certificate authority), and
`TimeStamperCertificate` should be present. The same check works on
`OtherBench.exe` and `uninstall.exe` in the install folder, or in Explorer
through the file's Properties → Digital Signatures tab. The job log of the
build step lists every file the sign command was given (`[sign] signed
...`), and the `sign.mjs verify` step after it prints the signer and
timestamp of the installer and of each file it checked inside it.

SmartScreen will still show its warning to the first people who download a
new signed build, until the publisher's reputation builds up over
downloads. The difference is that the warning names Otherworld as the
publisher rather than *Unknown publisher*, and the reputation carries over
from one release to the next instead of starting again with every unsigned
file.

## Timestamping

An Authenticode signature is only valid while its certificate is, and
Artifact Signing's certificates last three days. Each signature therefore
carries an RFC 3161 timestamp from `http://timestamp.acs.microsoft.com`,
countersigned by Microsoft's timestamping authority, which proves the file
was signed while the certificate was valid. Windows then keeps accepting
the signature after the certificate expires, for as long as the timestamp
authority's own certificate is trusted. Without the timestamp, every
installer would show as invalid three days after it was built. Both the
file digest and the timestamp use SHA-256 (`/fd SHA256 /td SHA256`).
`sign.mjs` tries a signature three times before failing the build, as the
signing service and the timestamp server each fail now and then.

## Rehearsing without a certificate

`sign.mjs` can sign with a local `.pfx` instead of Artifact Signing, which
is how the wiring was tested. With a throwaway self-signed certificate and a
throwaway updater key (never the real one):

```powershell
$env:OTHERBENCH_SIGN_PFX = 'C:\path\to\test.pfx'
$env:OTHERBENCH_SIGN_PFX_PASSWORD = '...'
$env:TAURI_SIGNING_PRIVATE_KEY = 'C:\path\to\throwaway-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '...'
npm run app:release -w @otherbench/desktop -- --config src-tauri/tauri.authenticode.conf.json
```

Then `node desktop/scripts/release/sign.mjs verify --rehearsal` checks
the result. The files come out signed by the test certificate, which
`Get-AuthenticodeSignature` reports as `UnknownError` (an untrusted root)
rather than `Valid`; `--rehearsal` accepts that, and the CI check, which
never passes it, would refuse them. Never point `TAURI_SIGNING_PRIVATE_KEY`
at the real updater key for a rehearsal.

A test certificate can be made with the OpenSSL that comes with Git for
Windows, without touching the Windows certificate store:

```sh
openssl req -x509 -newkey rsa:3072 -sha256 -days 7 -nodes -keyout test.key.pem -out test.crt.pem \
  -subj "/CN=OtherBench rehearsal (not trusted)" -addext "extendedKeyUsage=codeSigning"
openssl pkcs12 -export -out test.pfx -inkey test.key.pem -in test.crt.pem -passout pass:rehearsal
```

and a throwaway updater key with `npx tauri signer generate --ci -p
rehearsal -w <scratch folder>/updater-rehearsal.key` (run in `desktop`).
Tauri warns that this key does not match the public key in
`tauri.conf.json`, which is expected.

## Files

- `.github/workflows/ci.yml`, job `release`: the `authenticode` step, the
  .NET and `prepare` steps, the two build steps (one each way) and the
  signature check.
- `desktop/scripts/release/sign.mjs`: `enabled`, `prepare`, `sign`,
  `sign-native`, `verify`.
- `desktop/scripts/release/authenticode.mjs`: the settings, the pinned
  client, the endpoint check, signtool's arguments and the signature
  check; tested in `authenticode.test.mjs`.
- `desktop/src-tauri/tauri.authenticode.conf.json`: `signCommand` and
  `beforeBundleCommand`, added to the build only when signing is on.

## What has been tested, and what has not

Tested on 10 November 2026, on a Windows 11 machine:

- A full `app:release` build with the overlay and a throwaway `.pfx`, which
  produced the order of signing listed above. Every file inside the
  installer (the app, the NSIS plugins, both native modules) and the
  installer itself came out signed and timestamped by
  `timestamp.acs.microsoft.com`, `node.exe` and `claude.exe` kept their own
  publishers' signatures, and the updater `.sig` verified against the
  signed installer.
- `sign.mjs prepare` downloading and checking the pinned signing client,
  and signtool then loading it on .NET 10 and authenticating through the
  `AZURE_*` variables. With made-up credentials Entra refused them
  (`AADSTS700038`), the command tried three times and failed, and the
  secret did not appear in the output.
- `sign.mjs enabled` with none, all and some of the settings, and the
  workflow's step conditions for both cases.

Not tested, as there is no Artifact Signing account yet: a real signature
from the service, the role assignment, the account, profile and endpoint
names, the signer name `Get-AuthenticodeSignature` shows, whether
`actions/setup-dotnet` leaves the .NET 10 runtime where the client finds it
on the runner, and the job itself on GitHub's runner. The first push of
`dev` after the settings are added is that test, and if it fails the beta
is not published, so nothing unsigned goes out by mistake.
