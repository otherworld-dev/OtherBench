# Settings UI

A **Settings** button in the header (`App.tsx`) opens a full-screen overlay
(`packages/web/src/views/SettingsView.tsx`) with four tabs, each its own
panel under `packages/web/src/views/settings/`:

- **Connections** (`ConnectionsPanel.tsx`) — add/edit/delete a connection for
  any provider kind (`anthropic`, `openai`, `openai_compatible`, `google`,
  `ollama`, `mock`), **Test** it, and **Discover models** on it
  (`POST /connections/:id/discover-models`). The API key field is
  write-only: the server never returns a stored key, only a `secretRef`, and
  the form never pre-fills it — you either type a new one or tick "Clear."
- **Models** (`ModelsPanel.tsx`) — edit a model's capability flags
  (`supportsVision`, `supportsTools`), context window, and pricing
  (`priceInPer1m`/`priceOutPer1m`/`priceCachedPer1m`). A hand-edited row is
  marked `source: 'manual'` server-side (`routes/models.ts`) so a later
  re-discovery from the same connection doesn't silently overwrite it.
- **Profiles** (`ProfilesPanel.tsx`) — system prompt, sampling params
  (temperature, top-p, max output tokens, thinking budget), and tool policy
  (fs mode, shell on/off, approval mode, and an MCP-server allowlist
  checklist).
- **MCP Servers** (`McpServersPanel.tsx`) — full CRUD (create/edit/delete)
  for stdio and HTTP servers, env vars and headers (write-only, same pattern
  as connection API keys), and live health read the same way as the
  Inspector's: once, then again on each `mcp-changed` app event and each
  reconnect (`useLiveData`, `packages/web/src/lib/useLiveData.ts`), and at
  once after the panel's own actions.
- **Features** (`FeaturesPanel.tsx`) — turns GitHub and Nextcloud on or off
  on this machine (`githubEnabled`/`nextcloudEnabled` in `app_setting`, never
  synced). Off hides every surface that uses it (Issues, the Overview inbox,
  the Deck/Wiki/Links tabs, "Deck #N" links, the app form's fields, the
  Nextcloud settings tab) and the server stops reaching it: `githubOf` and
  `nextcloudOrThrow` refuse with 409 `github-off`/`nextcloud-off`
  (`server/src/features.ts`) and the Overview's check skips it. Apps keep
  their repo, board and wiki for when it's turned back on. A change emits
  `settings-changed` so every window re-reads them (`web/src/state/features.ts`).

**Ollama discovery seeds capabilities from Ollama's own API**, not just an
OpenAI-compatible shape: `AiSdkChatEngine` hits Ollama's native `GET
/api/tags` (`packages/engine-aisdk/src/engine.ts`) and reads each model's
`capabilities` array and `details.context_length` to set
`supportsVision`/`supportsTools`/`contextWindow` — richer than a generic
`openai_compatible` endpoint can offer, since that protocol has no
equivalent metadata.

**The tool runtime is now reachable end to end.** The Inspector
(`packages/web/src/panes/Inspector.tsx`) has a Workspace section: type in a
native, absolute path and it's saved via `PATCH /chats/:id` — that's the one
field `PermissionBroker.decide` requires to be non-null before it allows any
fs/shell tool call (`packages/core/src/domain/permissions.ts`). The server
now validates it too (`packages/server/src/validation.ts`, checked against
the server's own OS convention). Before this, the field existed only as a
type in the web API client and no component ever set it — every chat
created through the app had `workspaceRoot: null` and no tool could ever
run. Confirmed working via a scratch server and the mock provider's `#tool`
trigger while writing this doc.

The merge review for this branch found one Critical (opening the MCP env
editor and saving destroyed the stored secrets) plus nine further findings,
all fixed and re-verified against a real encrypted `SecretStore` and a real
Ollama instance.
