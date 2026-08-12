import type { JSX, ReactNode } from 'react';
import type { Chat } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

export interface InspectorProps {
  chat: Chat | null;
  profile: Profile | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="border-b border-[var(--border)] px-4 py-3 last:border-b-0">
      <h3 className="mb-2 text-xs font-semibold tracking-wide text-[var(--text-muted)] uppercase">{title}</h3>
      {children}
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-[var(--text-faint)]">{children}</p>;
}

function fmtParam(label: string, value: number | undefined): JSX.Element | null {
  if (value === undefined) return null;
  return (
    <div key={label} className="flex justify-between text-sm">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * The right pane. Exists specifically to surface the facts that cause harm
 * when hidden -- "this MCP server is down", "this chat can write to disk" --
 * so every section renders even when there is nothing to show yet, with an
 * honest empty state rather than being omitted. Tool grants, MCP health,
 * and spend all land in later tasks; this task wires the pane and its
 * collapse behaviour, not those features.
 */
export function Inspector({ chat, profile, collapsed, onToggleCollapsed }: InspectorProps): JSX.Element {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Expand inspector"
        aria-expanded={false}
        className="flex h-full w-9 flex-col items-center justify-center gap-2 border-l border-[var(--border)] bg-[var(--bg-raised)] text-[var(--text-muted)] hover:text-[var(--text)]"
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
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-sm font-semibold">Inspector</h2>
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

      <Section title="Profile parameters">
        {!chat ? (
          <EmptyState>No chat selected.</EmptyState>
        ) : !profile ? (
          <EmptyState>This chat's profile could not be loaded.</EmptyState>
        ) : (
          <div className="space-y-2">
            <div className="text-sm font-medium">{profile.name}</div>
            <div className="text-xs text-[var(--text-muted)]">{profile.modelId}</div>
            {profile.description && <p className="text-sm text-[var(--text-muted)]">{profile.description}</p>}
            <div className="space-y-1 pt-1">
              {fmtParam('Temperature', profile.params.temperature)}
              {fmtParam('Top P', profile.params.topP)}
              {fmtParam('Max output tokens', profile.params.maxOutputTokens)}
              {fmtParam('Thinking budget', profile.params.thinkingBudgetTokens)}
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-muted)]">Filesystem</span>
              <span>{profile.toolPolicy.fs}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--text-muted)]">Shell</span>
              <span>{profile.toolPolicy.shell ? 'on' : 'off'}</span>
            </div>
          </div>
        )}
      </Section>

      <Section title="Tool grants">
        <EmptyState>No grants issued in this chat yet.</EmptyState>
      </Section>

      <Section title="MCP server health">
        <EmptyState>No MCP servers are configured.</EmptyState>
      </Section>

      <Section title="Running session spend">
        <EmptyState>Spend tracking isn't wired up in this build yet -- the server exposes no usage endpoint.</EmptyState>
      </Section>
    </aside>
  );
}
