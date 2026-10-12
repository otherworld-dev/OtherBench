# Grunt

Grunt is a local, multi-model chat workbench. It runs as one Node server
(REST API + SSE streaming) with a React web UI, and lets you:

- Chat through **profiles** — a profile pairs a model (on a **connection**:
  Anthropic, OpenAI, an OpenAI-compatible endpoint, Google, Ollama, or the
  built-in mock provider) with a system prompt, parameters, and a tool
  policy.
- **Compare** the same prompt across two or three profiles side by side, and
  keep the reply you want — the others aren't discarded, just unselected.
- Let the assistant use **workspace-scoped tools** — read/write files inside
  a chosen directory, run shell commands, or call MCP servers — gated by an
  explicit, per-command approval flow. Nothing runs without a human saying
  yes, at whatever scope they choose (once, this chat, or always for a
  specific command/path).

Grunt runs either as `grunt serve` plus a browser, or as a desktop app (a
Tauri shell around the same UI and server — early days, see
[Desktop app](#desktop-app) below).

## Prerequisites

- **Node.js 24 or later.** Grunt uses Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html)
  module for persistence — no native SQLite binding, no build step. This
  needs to be the Node build's bundled SQLite compiled with **FTS5** support:
  Grunt's chat search (`GET /api/search`) is FTS5-backed with no fallback, so
  if `node:sqlite` on your machine lacks FTS5, search will error. It's
  present on the Node 24.16.0 build this was developed and verified against;
  if you hit `no such module: fts5` when searching, that's what's missing.
  One behavioural surprise worth knowing: search deliberately escapes FTS5's
  query syntax rather than passing it through, so a quoted `"credit card"`
  matches messages containing both words *anywhere*, not the exact adjacent
  phrase — a conscious tradeoff (every query is split on whitespace and each
  token is individually phrase-quoted) against FTS5 throwing a syntax error
  on ordinary things people type into a search box (a lone `"`, a trailing
  `AND`, a leading `-`, `col:value`). See `toFtsMatchExpression` in
  `packages/store-sqlite/src/repos/messages.ts` for the exact behaviour.
- **npm** (this repo uses npm workspaces, not pnpm — see `docs/HANDOVER.md`
  for why).

## Install and build

```sh
git clone <this-repo>
cd grunt
npm install
npm run build
```

`npm run build` compiles every package (`tsc -b`) and builds the web UI
(`vite build` into `packages/web/dist`).

## Run it

```sh
npm run serve
```

This starts the server on `http://127.0.0.1:4747` and serves the built web
UI from the same origin — open that URL in a browser. Useful flags (all
optional):

```
npm run serve -- --port 8080 --db ./my-grunt.db --host 0.0.0.0 --token secret123
```

- `--db <path>` — where the SQLite database lives (defaults to
  `~/.grunt/grunt.db`). Provider API keys are stored separately, encrypted,
  next to it (`secrets.json`) — see `docs/HANDOVER.md` for the exact
  guarantees that does and doesn't give you.
- `--host` — Grunt **refuses to start** on a non-loopback host unless you
  also pass `--token`, since that would otherwise expose the whole API
  (including a way to read provider keys) to anything that can reach it.
  Leave `--host` unset for ordinary local use.

A `grunt` CLI (`grunt serve ...`, same thing) is also declared as this
package's bin and gets linked into `node_modules/.bin` by `npm install` —
but that link is only created once `packages/server/dist/cli.js` already
exists, so on a first install (before the first build) it won't be there
yet; run `npm install` a second time after `npm run build` if you want it on
your `PATH`, or `npm link` from `packages/server`. `npm run serve` above
always works and needs neither.

## Desktop app

`desktop/` is a Tauri v2 shell. The web UI is bundled into the app (not
loaded from a URL), and the Grunt server runs as a hidden child process on a
random loopback port with a per-launch token. Closing the app stops the
server; so does the app crashing, since the server exits when its stdin
closes. It uses the same `~/.grunt/grunt.db` as `npm run serve`, and only one
of the two can have it open at a time (`<db>.lock`).

Extra prerequisites: Rust (stable, via `rustup`) and, on Windows, the MSVC
Build Tools (C++ workload) plus WebView2 (preinstalled on Windows 11).

```sh
npm install
npm run app:dev -w @grunt/desktop        # dev: Vite dev server + hot reload
cd desktop && npx tauri build --debug --no-bundle   # a runnable build with the UI embedded
```

Run from the checkout like this, the app finds `node` on `PATH` and the
server in `packages/server/dist` (`GRUNT_NODE` / `GRUNT_SERVER_SCRIPT`
override both).

To make a Windows installer that carries its own server and Node runtime:

```sh
npm run app:installer -w @grunt/desktop
```

It builds everything, bundles the server into one file (`npm run bundle -w
@grunt/server`, with the Claude Code runtime and PDF reader beside it),
smoke-tests the bundle, and writes
`desktop/src-tauri/target/release/bundle/nsis/Grunt_<version>_x64-setup.exe`
(about 100 MB). The installer is per-user and unsigned, so Windows
SmartScreen warns before it runs (*More info* → *Run anyway*).

## Two machines

Two Grunt installs can share chats, and a chat can run on whichever machine
has its folder.

1. **Pair them.** On one machine, Settings → Machines → *Show a code*. On the
   other, Settings → Machines → *Add a machine*: enter the address shown
   (`host:4748`) and the code. The first time Grunt listens for other
   machines, Windows asks whether to allow it: allow it on **Private**
   networks only. Pairing pins each machine's certificate, so something in
   between can't pass itself off as either.
2. **Set up locations.** Settings → Locations: a location is a folder you
   keep on both machines (say Nextcloud), wherever each one has it. A chat
   folder inside a location works on both. A chat whose folder isn't on this
   machine asks where it is before it sends anything.
3. **Choose where a chat runs.** The Inspector's *Runs on* picks the machine
   whose folder, tools and local models the chat uses. If that machine is
   off, the chat offers to run here instead.

Chats, messages, profiles, connections (with their keys, unless a
connection is set to keep its key on its machine), projects and locations
sync both ways. Grants, MCP servers and the audit log stay on each machine.
`grunt serve` takes `--peer-port` and `--peer-host` to choose where it
listens for paired machines.

## Use it from another device

`grunt serve` can run on an always-on box and be used from a laptop's or a
phone's browser, behind a password and HTTPS. The desktop app and the
loopback browser mode don't change.

1. **Set a password** on the box, at least 12 characters:

   ```sh
   grunt password            # or: node packages/server/dist/cli.js password
   ```

   It goes in `login.json` beside `secrets.json` (`~/.grunt/` by default; pass
   the same `--db` as `serve`). Run it again any time, even while the server
   runs, to change it; every signed-in device is then signed out.

2. **Start the server with the address the browser will type**, and an HTTPS
   route. With Grunt's own certificate:

   ```sh
   grunt serve --host 0.0.0.0 --public-url https://192.168.1.20:4747 --public-url https://box.lan:4747 --tls auto
   ```

   `--public-url` can be given more than once; each is `https://host[:port]`.
   The other routes are your own certificate files (`--tls-cert <file>
   --tls-key <file>`, for example from mkcert or `tailscale cert`) or an
   HTTPS proxy in front (`--trust-proxy <its IP>`).

3. **Trust the certificate** on each device (with `--tls auto`). First, on
   the box, note the SHA-256 fingerprint `grunt serve` prints. Then:
   - **Windows:** open `https://<public url>/grunt-ca.crt` (accept the one
     warning), open the file, *Install Certificate* → *Current User* →
     *Trusted Root Certification Authorities*. Edge and Chrome use it. If
     Firefox still warns, import the file under its own *Settings* →
     *Certificates* → *Authorities*.
   - **macOS:** open the file in Keychain Access and set it to *Always Trust*.
   - **iPhone/iPad:** open the URL in Safari, tap through the warning and
     allow the profile download; *Settings* → *Profile Downloaded* →
     *Install*; then *Settings* → *General* → *About* → *Certificate Trust
     Settings* and turn it on. Check the SHA-256 under the profile's *More
     Details*.
   - **Android:** download it in Chrome, then *Settings* → *Security* →
     *Encryption & credentials* → *Install a certificate* → *CA certificate*
     (the path varies by phone). Firefox for Android needs *Use third party
     CA certificates* in its secret settings.

   Check the fingerprint on the device against the one the server printed,
   never against a web page: on a network someone else controls, the page
   could be theirs. Clicking through the warning instead works in desktop
   browsers, but then the password goes to a server the browser hasn't
   checked. The certificate lasts about two years, and changing the public
   URLs makes a new one; each device has to trust it again then.

4. **Sign in** at the public URL. *Keep me signed in on this device* keeps
   the session for 30 days, otherwise 12 hours. Restarting the server signs
   every device out. Settings → Remote access shows the addresses and the
   certificate and has *Sign out everywhere*.

Behind a proxy, Grunt listens in plain HTTP and the proxy does TLS. It must
pass the original `Host` (or `127.0.0.1:<port>`) and set `X-Forwarded-For`:

- **Caddy:** `grunt.example.com { reverse_proxy 127.0.0.1:4747 }`, with
  `--public-url https://grunt.example.com --trust-proxy 127.0.0.1`.
- **nginx:** `proxy_set_header Host $host; proxy_set_header X-Forwarded-For
  $proxy_add_x_forwarded_for; proxy_buffering off;`.
- **Tailscale:** `tailscale serve --bg http://127.0.0.1:4747`, with
  `--public-url https://<box>.<tailnet>.ts.net --trust-proxy 127.0.0.1`.

**What a signed-in browser can do is everything the local UI can:** approve
shell commands, browse folders anywhere on the box, attach a file by path.
Use a long password you use nowhere else, and prefer a LAN or a tailnet to
the open internet. Five wrong passwords from one address lock it out for 15
minutes; a hundred in an hour close sign-in for everyone for the rest of the
hour.

## Claude Code

A **Claude Code** connection runs turns through your local Claude Code install
(via the Claude Agent SDK) instead of calling a model API directly.

- **Base URL empty**: uses your Claude login (run `claude` and `/login` once).
  No API key; `ANTHROPIC_API_KEY` is never passed through.
- **Base URL set** (e.g. `http://localhost:11434` for Ollama): runs that
  endpoint's models through Claude Code. Pick a tool-capable model.

Claude Code profiles need a workspace folder on the chat. Claude Code's own
tools (Read, Edit, Bash, ...) replace Grunt's fs/shell/MCP tools for those
turns, and Grunt's profile policy decides every call: under "ask on mutate",
reads inside the workspace are allowed automatically and edits, shell commands,
web and MCP calls get an approval card. Your `~/.claude` settings, CLAUDE.md
files and MCP servers apply, and so do the workspace's own `.claude` settings,
hooks and skills, `.mcp.json` and CLAUDE.md, with no trust prompt -- only use
folders you trust as workspaces. Chats are real Claude Code sessions: the
Inspector shows a `claude --resume` command to continue one in a terminal
(changes made there don't come back into Grunt).

## Try it with no API key — the mock provider

Grunt ships a keyless **mock provider** (`kind: "mock"`) specifically so you
can evaluate the whole app — streaming, tool calls, approvals, compare —
without any real credentials.

With the server running (`npm run serve`, default port 4747), open
`http://127.0.0.1:4747` and use the **Settings** button in the header:

**1. Settings → Connections → New connection.** Pick kind `mock`, give it a
name, save. No API key needed for this kind.

**2. Settings → Profiles → New profile.** Point it at the connection you just
made and model `mock-standard` (the mock provider's only model — it always
exists, no discovery step needed). Turn tool access on — `fs: readwrite`,
approval mode `always_ask` — so the `#tool` trigger below shows the real
approval flow, not just a placeholder. Tick "Default" so new chats use it
automatically.

**3. Back in the chat list, create a new chat, then open the Inspector pane
and set a Workspace path.** This is the one field that turns on filesystem
and shell tools for that chat — without it, `#tool` below will fail with a
permission error. It has to be a proper **native, absolute** path.

**4. Type `#tool notes.txt` as a message** (create a real `notes.txt` in that
workspace directory first) and see the walkthrough table below.

That's the whole flow through the UI — no `curl`, no REST calls by hand.

### The same thing via curl

Everything above is equally reachable directly against the REST API, which
is what the Settings UI itself calls — useful for scripting or if you'd
rather not open a browser yet. Same server, default port 4747:

**1. Create a mock connection:**

```sh
curl -X POST http://127.0.0.1:4747/api/connections \
  -H "Content-Type: application/json" \
  -d '{"name":"Mock","kind":"mock"}'
```

Note the `"id"` in the response (a UUID) — call it `CONN_ID`.

**2. Create a profile on it**, with tool access turned on so the `#tool`
trigger below shows the real approval flow, not just a placeholder:

```sh
curl -X POST http://127.0.0.1:4747/api/profiles \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Mock",
    "connectionId": "CONN_ID",
    "modelId": "mock-standard",
    "isDefault": true,
    "toolPolicy": { "fs": "readwrite", "shell": false, "mcpServerIds": [], "approvalMode": "always_ask" }
  }'
```

Note this response's `"id"` too — call it `PROFILE_ID`. (`mock-standard` is
the mock provider's only model; it always exists, no discovery step needed.)

**3. Create a chat with a real workspace directory**, so `#tool` has an
actual file to read. `workspaceRoot` has to be a proper **native, absolute**
path — on Linux/macOS:

```sh
mkdir -p /tmp/grunt-demo && echo "the treasure is buried under the oak tree" > /tmp/grunt-demo/notes.txt

curl -X POST http://127.0.0.1:4747/api/chats \
  -H "Content-Type: application/json" \
  -d '{"title":"Mock demo","profileId":"PROFILE_ID","workspaceRoot":"/tmp/grunt-demo"}'
```

On Windows, use a drive-letter path — e.g. `C:\Users\you\grunt-demo`
(escape backslashes as `\\` in the JSON body, or use forward slashes,
`C:/Users/you/grunt-demo`, which Node accepts just as well). **If you're in
Git Bash, don't pass `pwd`'s own output directly** — `pwd` prints
`/c/Users/you/grunt-demo`, and the server (an ordinary Windows Node
process) resolves that as `C:\c\Users\you\grunt-demo`, one directory level
that doesn't exist, and every read fails with `ENOENT` (checked: this is
exactly what happens, not a hypothetical). Use `pwd -W` instead, which
prints the drive-letter form:

```sh
mkdir -p ~/grunt-demo && echo "the treasure is buried under the oak tree" > ~/grunt-demo/notes.txt
WORKSPACE="$(cd ~/grunt-demo && pwd -W)"

curl -X POST http://127.0.0.1:4747/api/chats \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Mock demo\",\"profileId\":\"PROFILE_ID\",\"workspaceRoot\":\"$WORKSPACE\"}"
```

**4. Open `http://127.0.0.1:4747`**, click **"Mock demo"** in the chat list
(this is the step where the two paths above converge — the UI part starts
here regardless of how the connection/profile/chat were created), and try
each of these as separate messages:

| Type this | You'll see |
| --- | --- |
| *(anything else)* | A short canned reply streamed in over several chunks — proves the SSE pipe works end to end. |
| `#slow` | The same idea, deliberately trickled one word at a time over ~8s — watch the streaming indicator animate. |
| `#fail` | A simulated provider error (rate limit), rendered as an error state instead of hanging — proves failure handling works, not just the happy path. |
| `#long` | A ~2000-word reply streamed fast — good for checking scroll/render performance. |
| `#tool notes.txt` | The model calls `read_file`. Because this profile's tool policy is `always_ask`, an inline approval prompt appears first ("Wants to run **read_file**..."). Click **Allow once**, and the model's answer will quote the real file content back at you — not a fabrication. |

That's the whole evaluation loop: no API key, no external network call, real
streaming, a real (if trivial) tool execution behind a real approval gate.

## Using a real provider

Same shape, different `kind` and an API key — through Settings → Connections
in the UI, or the same curl call with a real key:

```sh
curl -X POST http://127.0.0.1:4747/api/connections \
  -H "Content-Type: application/json" \
  -d '{"name":"Anthropic","kind":"anthropic","apiKey":"sk-ant-..."}'
```

`kind` is one of `anthropic`, `openai`, `openai_compatible`, `google`,
`ollama`, or `mock`. For `openai_compatible`, also pass `baseUrl`. The key is
stored via `SecretStore` (encrypted at rest, see `docs/HANDOVER.md`), never
in the SQLite database itself. Then click **Discover models** on that
connection in Settings (or `POST /api/connections/:id/discover-models`, or
add one by hand via `POST /api/models`) and create a profile against a real
`modelId`, same as above.

## Tests

```sh
npx vitest run              # unit + integration, 953 pass, 3 skipped as of this writing
npm run typecheck
cd packages/web && npx playwright test   # e2e, requires npm run build first
```

## More

`docs/HANDOVER.md` — what's actually built (milestone by milestone), the
security posture stated plainly, known gaps, and every deliberate deviation
from the original spec. Read that before trusting this app with anything you
care about, or before picking up where this session left off.
