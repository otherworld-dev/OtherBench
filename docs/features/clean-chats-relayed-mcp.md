# Clean chats, relayed MCP and the Claude Desktop import

These follow spec 2026-10-11-claude-code-clean-chat-and-mcp-design. They replace two lines of the Claude Code engine spec: the non-goal "Passing OtherBench's own fs/shell/MCP tools into Claude Code" (for MCP), and "`mcpServerIds` is ignored for Claude Code profiles".

- **Clean chats.** A Claude Code chat with no workspace folder is no longer refused. It runs as a clean chat.
  - **Where it runs.** Its own scratch folder, `<data dir>/claude-scratch/<chat id>`, which is the same folder every turn so the session resumes. With `--db :memory:` it is a private temp folder.
  - **What it loads.** `settingSources: []` and `strictMcpConfig: true`: none of the user's Claude Code settings, CLAUDE.md, skills, hooks or MCP config.
  - **Built-in tools.** Only `WebSearch` and `WebFetch` (`tools`), or none when the profile turns web off.
  - **System prompt.** The profile's composed prompt as a plain string, with no coding-agent preset.
  - **Approvals.** The gate and broker still see no workspace. OtherBench's own tools (artifact, recall, relayed MCP) and agent `web` tools go on to the usual approval. File, shell and Claude Code's own `mcp__*` tools are refused, with "This chat has no folder: …".
  - **Adding a folder later.** The next turn starts a fresh session in that folder.
  - **Deleting a chat.** Its scratch folder is removed too.
- **OtherBench's MCP servers in Claude Code chats.** Claude Code profiles now use the MCP checklist ("MCP servers (from OtherBench)").
  - **How tools get there.** OtherBench's per-process server (`otherbench_<16 hex>`) carries one tool per tool of each allowlisted, connected server, in folder and clean chats alike. They come from `OtherBenchToolProvider.relayMcpTools`: the same specs `listTools` builds, but ungated.
  - **Naming.** Claude Code calls them `mcp__otherbench_<hex>__<server>__<tool>`, cut to 64 characters with a short hash when longer (`engine-claude-code/src/relay.ts`).
  - **Approval.** The gate approves each call with the very ToolSpec an API model would get (`source: 'mcp'`, its server id and hint risk). Grants, the read-only pass under "ask on mutate" and cards therefore behave the same, and only then does the server run the call through OtherBench's own MCP connection.
  - **Reporting and restarts.** Calls are reported under the API name `mcp__<server>__<tool>`. A change to the relayed tools starts a new process.
  - **How the server is built.** It answers `tools/list` and `tools/call` itself on an MCP `McpServer` rather than through the SDK's zod-only `tool()` helper, so the tools keep their real JSON schemas. A live probe confirmed Claude Code uses a tool served this way, even with no settings and no built-in tools (`test/fixtures/raw-server-probe.mjs` and its README section).
  - **Claude Code's own MCP config.** The "MCP servers from your Claude Code config" switch still governs it, in folder chats only.
- **Import from Claude Desktop** (Settings > MCP servers).
  - **Reading the config.** `GET /api/mcp-servers/import/claude-desktop` reads Claude Desktop's config: `%APPDATA%\Claude\claude_desktop_config.json`, the macOS or Linux equivalent, or `OTHERBENCH_CLAUDE_DESKTOP_CONFIG`. It lists the servers by name, command or URL, and the names of their env vars and headers.
  - **Importing.** `POST` with the chosen names re-reads the file and creates them through the same code as `POST /api/mcp-servers`, so values go straight into the secret store and never reach the browser.
  - **Skipped servers.** Existing names, SSE servers and malformed entries are skipped with a reason.
  - **Profiles.** Imported servers start enabled, and are turned on only for the profiles ticked under "Turn on for" (none by default). `POST` takes them as `profileIds`, refuses an unknown one with a 400 before creating anything, and returns the updated profiles.
- **Turning servers on from the Inspector.** The Inspector's "MCP servers" section lists every server with its health, and with the chat's profile loaded each has a box for whether that profile may use it. Ticking one saves the profile's `toolPolicy.mcpServerIds` (`PATCH /api/profiles/:id` with just that field), the same list as Settings > Profiles, so it applies to every chat on the profile from the next message. Servers the profile can't use are dimmed. In a compare chat the boxes follow the chat's main profile.
- **Gaps.**
  - Each Claude Code process gets its own relay, but the real servers run once in OtherBench's manager, so a stateful server's state is shared between chats (as it already was for API profiles).
  - A relayed call's result isn't added to the audit trail; only its approval is ("delegated to Claude Code").
  - The import is one-off: changes to Claude Desktop's config later aren't followed.
