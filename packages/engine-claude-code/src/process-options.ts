import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk';
import { CLEAN_CHAT_AGENT_TOOLS, agentDisallowedTools } from '@otherbench/core/domain/agent-tools.js';
import type { EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import type { ResolvedFolder } from '@otherbench/core/types/workspace.js';
import type { ClaudeCodeEngineDeps } from './deps.js';
import { buildChildEnv } from './env.js';
import { claudeGlobalFiles, claudeProjectFolders, claudeSkillFolders } from './skill-folders.js';

/**
 * Deny rules for the claude-setup standard's secrets (core isSecretAgentPath),
 * on the SDK's flag-settings layer, so they hold whatever the project's own
 * settings say. OtherBench's gate refuses a file tool aimed at one, but a Grep
 * or Glob over a whole folder reads what it finds there: Claude Code turns
 * these rules into exclusions inside those tools. Unanchored patterns apply to
 * every search wherever it starts (the chat's folder, an extra folder, the
 * user's skills); a `//` one would only cover the current drive on Windows.
 */
export const SECRET_DENY_RULES: readonly string[] = ['Read', 'Edit'].flatMap((tool) =>
  ['**/.env', '**/.env.*', '**/.claude/certificates/**'].map((p) => `${tool}(${p})`)
);

/**
 * The flag-settings layer every turn's process gets (above user/project/local):
 * skills and slash commands may not run their inline !`cmd` shell, which would
 * run inside the 'internal' Skill tool and get no card (R14); and the secrets'
 * deny rules.
 */
const processSettings = (): Settings => ({ disableSkillShellExecution: true, permissions: { deny: [...SECRET_DENY_RULES] } });

/**
 * The user's own skills and plugins, read-only, and Claude Code's own project
 * folder for the workspace, its memory writable, and the global CLAUDE.md, for
 * the gate alone (skill-folders.ts): a skill may read its own files and Claude
 * Code may keep its notes and edit the global instructions with its file tools. Not part of the reply's tool context, so the
 * sandboxed shell and relayed tools never get them.
 */
export function claudeFolders(deps: ClaudeCodeEngineDeps, workspaceRoot: string | null, account: ClaudeAccountRef | undefined): ResolvedFolder[] {
  if (!workspaceRoot) return [];
  const base = deps.baseEnv ?? process.env;
  // Another account's skills and projects are in its own config folder; main reads the inherited one as before.
  const env = account?.configDir ? { ...base, CLAUDE_CONFIG_DIR: account.configDir } : base;
  return [...claudeSkillFolders(env, workspaceRoot), ...claudeProjectFolders(env, workspaceRoot), ...claudeGlobalFiles(env, workspaceRoot)];
}

/** The options a Claude Code process is started with, minus what each process wires up itself (startProcess). */
export function processOptions(deps: ClaudeCodeEngineDeps, req: EngineRequest, cwd: string, autoMode: boolean, clean: boolean): Options {
  const profile = req.profile;
  if (clean) {
    // A clean chat (spec 2026-10-11-claude-code-clean-chat-and-mcp-design
    // §1): none of the user's Claude Code settings, CLAUDE.md, skills, hooks
    // or MCP config, no coding-agent prompt, and of the built-in tools only
    // web search and fetch, the checklist and questions. Its MCP tools are OtherBench's own server's.
    return {
      cwd,
      model: profile.modelId,
      env: buildChildEnv(deps.baseEnv ?? process.env, profile.connection, profile.apiKey, profile.modelId, req.claudeAccount),
      permissionMode: autoMode ? 'auto' : 'default',
      includePartialMessages: true,
      settingSources: [],
      strictMcpConfig: true,
      settings: processSettings(),
      // Web search and fetch, plus the checklist and questions (spec 2026-10-12-thread-cards-design section 6).
      tools: [...(profile.toolPolicy.agentWeb === false ? [] : ['WebSearch', 'WebFetch']), ...CLEAN_CHAT_AGENT_TOOLS],
      disallowedTools: agentDisallowedTools(profile.toolPolicy),
      ...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
      ...(profile.params.thinkingBudgetTokens ? { thinking: { type: 'enabled', budgetTokens: profile.params.thinkingBudgetTokens } } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
    };
  }
  return {
    cwd,
    model: profile.modelId,
    env: buildChildEnv(deps.baseEnv ?? process.env, profile.connection, profile.apiKey, profile.modelId, req.claudeAccount),
    permissionMode: autoMode ? 'auto' : 'default',
    includePartialMessages: true,
    // The folder's own settings; the user's (their CLAUDE.md, skills, plugins, hooks and MCP servers)
    // only when the profile asks, since they cost about 17K tokens a session (test/fixtures/README.md).
    settingSources: profile.toolPolicy.agentUserSettings === true ? ['user', 'project', 'local'] : ['project', 'local'],
    // Flag-settings layer: no skill inline shell (R14), and the secrets' deny rules.
    settings: processSettings(),
    disallowedTools: agentDisallowedTools(profile.toolPolicy),
    systemPrompt: profile.systemPrompt ? { type: 'preset', preset: 'claude_code', append: profile.systemPrompt } : { type: 'preset', preset: 'claude_code' },
    // MCP off: load no MCP config but the servers passed here (only OtherBench's
    // own, for artifacts and recall), so the model isn't offered the user's MCP tools
    // and none of their servers start. The gate still denies MCP calls.
    ...(profile.toolPolicy.agentMcp === false ? { strictMcpConfig: true } : {}),
    ...(profile.params.thinkingBudgetTokens ? { thinking: { type: 'enabled', budgetTokens: profile.params.thinkingBudgetTokens } } : {}),
    // The chat's effort (chosen in the chat window) over the user's Claude Code settings; unset leaves those to decide.
    ...(req.effort ? { effort: req.effort } : {}),
    // The chat's extra folders are deliberately NOT additionalDirectories:
    // Claude Code would load the skills and commands under each one's
    // .claude. It reaches them anyway when the gate allows a call (live
    // probe, test/fixtures/README.md), and the system prompt names them.
  };
}
