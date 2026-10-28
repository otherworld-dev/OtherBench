import { useEffect, useMemo, useState, type JSX } from 'react';
import type { EngineMeta } from '@otherbench/core/types/messages.js';
import { api } from '../state/api.js';
import { isClaudeLoginChat, useClaudeAccounts } from '../state/claudeAccounts.js';
import { useOtherBenchStore } from '../state/store.js';
import { useSectionSummary } from './InspectorSection.js';

/** True for a Windows user agent: the resume command is a PowerShell one there. */
export function isWindowsPlatform(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return userAgent.includes('Windows');
}

/**
 * The terminal command that picks the session up. A non-main account's reply also needs its
 * `CLAUDE_CONFIG_DIR` (`configDir`), set the PowerShell way on Windows and the shell way elsewhere.
 */
export function resumeCommand(meta: EngineMeta, opts: { windows: boolean; configDir: string | null } = { windows: isWindowsPlatform(), configDir: null }): string {
  const { cwd, sessionId } = meta;
  if (!meta.account || !opts.configDir) return `cd "${cwd}" && claude --resume ${sessionId}`;
  return opts.windows
    ? `$env:CLAUDE_CONFIG_DIR = "${opts.configDir}"; cd "${cwd}"; claude --resume ${sessionId}`
    : `cd "${cwd}" && CLAUDE_CONFIG_DIR="${opts.configDir}" claude --resume ${sessionId}`;
}

interface McpServerGroup {
  name: string;
  status: string | null;
  tools: string[];
}

/**
 * Splits Claude Code's reported tool list into its built-in tools and one
 * group per MCP server. MCP tools are named `mcp__<server>__<tool>`, with the
 * server name sanitised the way Claude Code does it (anything outside
 * `[A-Za-z0-9_-]` becomes `_`), so reported server names are matched in that
 * form. `servers` holds those with at least one tool (most tools first); `empty`
 * holds the ones that reported a status but no tools. Tool prefixes with no reported server get a group with no status.
 */
export function groupTools(meta: EngineMeta): { builtIn: string[]; servers: McpServerGroup[]; empty: McpServerGroup[] } {
  const sanitise = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');
  const servers = new Map<string, McpServerGroup>();
  for (const s of meta.mcpServers ?? []) servers.set(sanitise(s.name), { name: s.name, status: s.status, tools: [] });

  const builtIn: string[] = [];
  for (const tool of meta.tools ?? []) {
    const match = /^mcp__(.+?)__(.+)$/.exec(tool);
    const server = match?.[1];
    const name = match?.[2];
    if (!server || !name) {
      builtIn.push(tool);
      continue;
    }
    let group = servers.get(server);
    if (!group) {
      group = { name: server, status: null, tools: [] };
      servers.set(server, group);
    }
    group.tools.push(name);
  }
  const all = [...servers.values()];
  const withTools = all.filter((g) => g.tools.length > 0).sort((a, b) => b.tools.length - a.tools.length || a.name.localeCompare(b.name));
  const empty = all.filter((g) => g.tools.length === 0).sort((a, b) => a.name.localeCompare(b.name));
  return { builtIn, servers: withTools, empty };
}

function serverLabel(group: McpServerGroup): string {
  const count = `${group.tools.length} tool${group.tools.length === 1 ? '' : 's'}`;
  return group.status ? `${group.name} · ${group.status} · ${count}` : `${group.name} · ${count}`;
}

/** The chat's latest Claude Code session: what it ran on, what it could use, and how to pick it up in a terminal. */
export function ClaudeCodeSection({ chatId }: { chatId: string }): JSX.Element | null {
  const messages = useOtherBenchStore((s) => s.messages);
  const chat = useOtherBenchStore((s) => s.chats.find((c) => c.id === chatId));
  const profiles = useOtherBenchStore((s) => s.profiles);
  const connections = useOtherBenchStore((s) => s.connections);
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
  const accounts = useClaudeAccounts((s) => s.accounts);
  const loadAccounts = useClaudeAccounts((s) => s.load);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const meta = useMemo(() => {
    const withMeta = Object.values(messages).filter((m) => m.chatId === chatId && m.engineMeta);
    withMeta.sort((a, b) => b.createdAt - a.createdAt);
    return withMeta[0]?.engineMeta ?? null;
  }, [messages, chatId]);
  const toolCount = meta?.tools?.length ?? 0;
  const login = isClaudeLoginChat(chat, profiles, connections);
  const showAccounts = login && accounts.length > 0;
  useEffect(() => {
    if (login && accounts.length === 0) loadAccounts().catch((err: unknown) => console.error('[otherbench-web] failed to load the Claude accounts:', err));
  }, [login, accounts.length, loadAccounts]);
  useSectionSummary(meta ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : null);
  if (!meta && !showAccounts) return null;

  async function save(body: { claudeAccount: string | null } | { accountAutoSwitch: boolean }): Promise<void> {
    setSaveError(null);
    try {
      upsertChat(await api.chats.patch(chatId, body));
    } catch (err) {
      console.error('[otherbench-web] failed to change the Claude account:', err);
      setSaveError(err instanceof Error ? err.message : "Couldn't save. Please try again.");
    }
  }

  const accountControls = showAccounts && chat && (
    <div className="mb-2 space-y-1 text-xs">
      <div className="flex items-center gap-2">
        <label htmlFor={`claude-account-${chatId}`} className="text-[var(--text-muted)]">Account</label>
        <select
          id={`claude-account-${chatId}`}
          value={chat.claudeAccount ?? ''}
          onChange={(e) => void save({ claudeAccount: e.target.value === '' ? null : e.target.value })}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-1 py-0.5"
        >
          <option value="">Default (Main, overflow to others)</option>
          {chat.claudeAccount && !accounts.some((a) => a.slug === chat.claudeAccount) && <option value={chat.claudeAccount}>{chat.claudeAccount} (missing)</option>}
          {accounts.map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={chat.accountAutoSwitch === true} onChange={(e) => void save({ accountAutoSwitch: e.target.checked })} />
        Switch automatically
      </label>
      {saveError && <p role="alert" className="text-[var(--danger)]">{saveError}</p>}
    </div>
  );
  if (!meta) return accountControls || null;
  const { builtIn, servers, empty } = groupTools(meta);
  const replyAccount = meta.account ? accounts.find((a) => a.slug === meta.account) : undefined;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(resumeCommand(meta!, { windows: isWindowsPlatform(), configDir: replyAccount?.configDir ?? null }));
      setCopied(true);
    } catch (err) {
      console.error('[otherbench-web] failed to copy resume command:', err);
    }
  }

  return (
    <>
    {accountControls}
    <dl className="space-y-1 text-xs">
      <div className="flex gap-2"><dt className="text-[var(--text-muted)]">Backend</dt><dd>{meta.backend === 'claude' || meta.account ? 'Claude login' : meta.backend}</dd></div>
      {meta.account && <div className="flex gap-2"><dt className="sr-only">Account</dt><dd>Account: {replyAccount?.name ?? meta.account}</dd></div>}
      <div className="flex gap-2"><dt className="text-[var(--text-muted)]">Session</dt><dd className="font-mono">{meta.sessionId}</dd></div>
      {builtIn.length > 0 && (
        <div className="flex gap-2">
          <dt className="text-[var(--text-muted)]">Tools</dt>
          <dd className="min-w-0 flex-1">
            <details>
              <summary className="cursor-pointer">{builtIn.length} built-in tool{builtIn.length === 1 ? '' : 's'}</summary>
              <p className="mt-0.5 break-words pl-3 text-[var(--text-muted)]">{builtIn.join(', ')}</p>
            </details>
          </dd>
        </div>
      )}
      {(servers.length > 0 || empty.length > 0) && (
        <div className="flex gap-2">
          <dt className="text-[var(--text-muted)]">MCP</dt>
          <dd className="min-w-0 flex-1 space-y-0.5">
            {servers.map((group) => (
              <details key={group.name}>
                <summary className="cursor-pointer break-words">{serverLabel(group)}</summary>
                {group.tools.length > 0 && <p className="mt-0.5 break-words pl-3 text-[var(--text-muted)]">{group.tools.join(', ')}</p>}
              </details>
            ))}
            {empty.length > 0 && (
              <details>
                <summary className="cursor-pointer break-words">{empty.length} more with no tools (needs sign-in or failed)</summary>
                <ul className="mt-0.5 break-words pl-3 text-[var(--text-muted)]">
                  {empty.map((g) => <li key={g.name}>{g.status ? `${g.name} · ${g.status}` : g.name}</li>)}
                </ul>
              </details>
            )}
          </dd>
        </div>
      )}
      <button type="button" onClick={() => void copy()} aria-label="Copy resume command" className="btn mt-1 px-2 py-0.5">
        {copied ? 'Copied' : 'Copy terminal resume command'}
      </button>
    </dl>
    </>
  );
}
