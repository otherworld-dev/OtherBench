import { useMemo, type JSX } from 'react';
import { latestTodos } from '@otherbench/core/domain/thread-tools.js';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { useOtherBenchStore } from '../state/store.js';
import { ClaudeCodeSection } from './ClaudeCodeSection.js';
import { isClaudeLoginChat } from '../state/claudeAccounts.js';
import { InspectorMemory } from './InspectorMemory.js';
import { InspectorProject } from './InspectorProject.js';
import { Section } from './InspectorSection.js';
import { TodoChecklist } from '../components/TodoChecklist.js';
import { EmptyState, ElsewhereNote } from './InspectorParts.js';
import { OtherFoldersSection, RunsOn, WorkspaceSection } from './InspectorWorkspace.js';
import { ProfileSection } from './InspectorProfile.js';
import { GrantsSection, ProfileSiteList } from './InspectorGrants.js';
import { McpServersSection } from './InspectorMcp.js';
import { AuditSection } from './InspectorAudit.js';
import { SessionSpend } from './InspectorSpend.js';

export interface InspectorProps {
  chat: Chat | null;
  profile: Profile | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The collapsed strip can't be expanded (no chat selected, so there is nothing to inspect). */
  disabled?: boolean;
}

/** Running replies' checklists (spec 2026-10-12-thread-cards-design §7); the section exists only while one is running with a checklist. */
function ProgressSection({ chatId }: { chatId: string }): JSX.Element | null {
  const messages = useOtherBenchStore((s) => s.messages);
  const running = useMemo(
    () =>
      Object.values(messages)
        .filter((m) => m.chatId === chatId && m.role === 'assistant' && m.status === 'streaming')
        .flatMap((m) => {
          const todos = latestTodos(m.parts);
          return todos ? [{ id: m.id, profileName: m.producedBy?.profileName ?? 'Assistant', todos }] : [];
        }),
    [messages, chatId]
  );
  if (running.length === 0) return null;
  return (
    <Section title="Progress" collapsible={false}>
      <div className="space-y-2">
        {running.map((r) => (
          <div key={r.id}>
            {running.length > 1 && <div className="text-xs text-[var(--text-muted)]">{r.profileName}</div>}
            <TodoChecklist todos={r.todos} streaming />
          </div>
        ))}
      </div>
    </Section>
  );
}

function ClaudeCodeInspectorSection({ chatId }: { chatId: string }): JSX.Element | null {
  const hasSession = useOtherBenchStore((s) => Object.values(s.messages).some((m) => m.chatId === chatId && !!m.engineMeta));
  const login = useOtherBenchStore((s) => isClaudeLoginChat(s.chats.find((c) => c.id === chatId), s.profiles, s.connections));
  if (!hasSession && !login) return null;
  return (
    <Section title="Claude Code session">
      <ClaudeCodeSection chatId={chatId} />
    </Section>
  );
}

/**
 * The right pane. Exists specifically to surface the facts that cause harm
 * when hidden -- "this MCP server is down", "this chat can write to disk" --
 * so every section renders even when there is nothing to show yet, with an
 * honest empty state rather than being omitted. Most sections start closed
 * to keep the pane short, but each header carries a one-line summary and a
 * problem colours it and opens it (see InspectorSection).
 */
export function Inspector({ chat, profile, collapsed, onToggleCollapsed, disabled = false }: InspectorProps): JSX.Element {
  // The chat's project, when it's loaded: the memory section needs both.
  const memoryProject = useOtherBenchStore((s) => (chat?.projectId ? (s.projects.find((p) => p.id === chat.projectId) ?? null) : null));
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={disabled ? undefined : onToggleCollapsed}
        aria-label="Expand inspector"
        aria-expanded={false}
        aria-disabled={disabled || undefined}
        title={disabled ? 'Select a chat to see its details' : undefined}
        className="flex h-full w-9 flex-col items-center justify-center gap-2 border-l border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-muted)] hover:text-[var(--text)] aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:text-[var(--text-muted)]"
      >
        <span className="[writing-mode:vertical-rl] text-xs tracking-wide">Inspector</span>
      </button>
    );
  }

  return (
    <aside
      aria-label="Inspector"
      className="flex h-full w-full flex-col overflow-y-auto border-l border-[var(--border)] bg-[var(--bg-raised)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
        <h2 className="label-caps text-base">Inspector</h2>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Collapse inspector"
          aria-expanded={true}
          className="text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          ✕
        </button>
      </div>

      <Section title="Project" collapsible={false}>
        {chat ? <InspectorProject chat={chat} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>

      {chat && <ProgressSection chatId={chat.id} />}

      <Section title="Workspace" defaultOpen>
        {chat ? (
          <>
            <RunsOn chat={chat} />
            <WorkspaceSection chat={chat} profile={profile} />
          </>
        ) : (
          <EmptyState>No chat selected.</EmptyState>
        )}
      </Section>

      {chat && (
        <Section title="Other folders" hint="Folders the model can also work in besides the workspace, by absolute path.">
          <OtherFoldersSection chat={chat} />
        </Section>
      )}

      <Section title="Profile">{chat ? <ProfileSection profile={profile} /> : <EmptyState>No chat selected.</EmptyState>}</Section>

      {chat && <ClaudeCodeInspectorSection chatId={chat.id} />}

      <Section title="Tool grants">
        <ElsewhereNote chat={chat} what="These are its grants there." />
        {chat ? (
          <>
            <ProfileSiteList profile={profile} />
            <GrantsSection chat={chat} />
          </>
        ) : (
          <EmptyState>No chat selected.</EmptyState>
        )}
      </Section>

      <Section title="MCP servers">
        <ElsewhereNote chat={chat} what="These are its MCP servers there; tick one to let the chat use it." />
        <McpServersSection chat={chat} profile={chat ? profile : null} />
      </Section>

      <Section title="Audit trail">
        <ElsewhereNote chat={chat} what="These are its tool calls there." />
        {chat ? <AuditSection chat={chat} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>

      {chat && memoryProject && (
        <Section title="Project memory">
          {/* Keyed by project so a response still in flight for the previous project can never land in this one. */}
          <InspectorMemory key={memoryProject.id} chat={chat} project={memoryProject} />
        </Section>
      )}

      <Section title="Spend">
        {chat ? <SessionSpend chatId={chat.id} /> : <EmptyState>No chat selected.</EmptyState>}
      </Section>
    </aside>
  );
}
