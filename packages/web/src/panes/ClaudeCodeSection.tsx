import { useMemo, useState, type JSX } from 'react';
import type { EngineMeta } from '@grunt/core/types/messages.js';
import { useGruntStore } from '../state/store.js';

export function resumeCommand(meta: EngineMeta): string {
  return `cd "${meta.cwd}" && claude --resume ${meta.sessionId}`;
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
  const messages = useGruntStore((s) => s.messages);
  const [copied, setCopied] = useState(false);
  const meta = useMemo(() => {
    const withMeta = Object.values(messages).filter((m) => m.chatId === chatId && m.engineMeta);
    withMeta.sort((a, b) => b.createdAt - a.createdAt);
    return withMeta[0]?.engineMeta ?? null;
  }, [messages, chatId]);
  if (!meta) return null;
  const { builtIn, servers, empty } = groupTools(meta);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(resumeCommand(meta!));
      setCopied(true);
    } catch (err) {
      console.error('[grunt-web] failed to copy resume command:', err);
    }
  }

  return (
    <dl className="space-y-1 text-xs">
      <div className="flex gap-2"><dt className="text-[var(--text-muted)]">Backend</dt><dd>{meta.backend === 'claude' ? 'Claude login' : meta.backend}</dd></div>
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
      <button type="button" onClick={() => void copy()} aria-label="Copy resume command" className="mt-1 rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--bg-sunken)]">
        {copied ? 'Copied' : 'Copy terminal resume command'}
      </button>
    </dl>
  );
}
