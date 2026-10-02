import { useMemo, useState, type JSX } from 'react';
import type { EngineMeta } from '@grunt/core/types/messages.js';
import { useGruntStore } from '../state/store.js';

export function resumeCommand(meta: EngineMeta): string {
  return `cd "${meta.cwd}" && claude --resume ${meta.sessionId}`;
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
      {meta.tools && meta.tools.length > 0 && (
        <div className="flex gap-2"><dt className="text-[var(--text-muted)]">Tools</dt><dd>{meta.tools.join(', ')}</dd></div>
      )}
      {meta.mcpServers && meta.mcpServers.length > 0 && (
        <div className="flex gap-2"><dt className="text-[var(--text-muted)]">MCP</dt><dd>{meta.mcpServers.map((s) => `${s.name} (${s.status})`).join(', ')}</dd></div>
      )}
      <button type="button" onClick={() => void copy()} aria-label="Copy resume command" className="mt-1 rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--bg-sunken)]">
        {copied ? 'Copied' : 'Copy terminal resume command'}
      </button>
    </dl>
  );
}
