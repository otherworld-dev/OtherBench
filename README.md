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

There is no desktop app (yet — see `docs/HANDOVER.md`). Grunt today is
`grunt serve` plus a browser.

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

## Try it with no API key — the mock provider

Grunt ships a keyless **mock provider** (`kind: "mock"`) specifically so you
can evaluate the whole app — streaming, tool calls, approvals, compare —
without any real credentials. There's no Settings UI yet (see
`docs/HANDOVER.md`), so connections, profiles, and chats are created
directly against the REST API for now; everything after that is normal
browser use.

With the server running (`npm run serve`, default port 4747):

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

**4. Open `http://127.0.0.1:4747`**, click **"Mock demo"** in the chat list,
and try each of these as separate messages:

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

Same shape, different `kind` and an API key:

```sh
curl -X POST http://127.0.0.1:4747/api/connections \
  -H "Content-Type: application/json" \
  -d '{"name":"Anthropic","kind":"anthropic","apiKey":"sk-ant-..."}'
```

`kind` is one of `anthropic`, `openai`, `openai_compatible`, `google`,
`ollama`, or `mock`. For `openai_compatible`, also pass `baseUrl`. The key is
stored via `SecretStore` (encrypted at rest, see `docs/HANDOVER.md`), never
in the SQLite database itself. Then `POST /api/connections/:id/discover-models`
(or add one by hand via `POST /api/models`) and create a profile against a
real `modelId`, same as above.

## Tests

```sh
npx vitest run              # unit + integration, ~750 tests (751 pass, 2 skipped as of this writing)
npm run typecheck
cd packages/web && npx playwright test   # e2e, requires npm run build first
```

## More

`docs/HANDOVER.md` — what's actually built (milestone by milestone), the
security posture stated plainly, known gaps, and every deliberate deviation
from the original spec. Read that before trusting this app with anything you
care about, or before picking up where this session left off.
