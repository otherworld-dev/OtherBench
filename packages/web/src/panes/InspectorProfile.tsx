import type { JSX, ReactNode } from 'react';
import type { Profile } from '@otherbench/core/types/config.js';
import { useSectionSummary } from './InspectorSection.js';
import { EmptyState } from './InspectorParts.js';

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }): JSX.Element {
  return (
    <>
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd data-testid={testId} className="min-w-0 break-words">
        {children}
      </dd>
    </>
  );
}

/** The chat's profile: name and model, then its parameters and tool policy as a compact grid. */
export function ProfileSection({ profile }: { profile: Profile | null }): JSX.Element {
  useSectionSummary(profile ? profile.name : 'not loaded', profile ? 'normal' : 'warn');
  if (!profile) return <EmptyState>This chat's profile could not be loaded.</EmptyState>;
  const { temperature, topP, maxOutputTokens, thinkingBudgetTokens } = profile.params;
  return (
    <div className="space-y-1.5">
      <div className="min-w-0 text-sm">
        <span className="font-medium">{profile.name}</span> <span className="text-xs break-all text-[var(--text-muted)]">{profile.modelId}</span>
      </div>
      {profile.description && (
        <p title={profile.description} className="line-clamp-2 text-xs text-[var(--text-muted)]">
          {profile.description}
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {temperature !== undefined && <Row label="Temperature">{temperature}</Row>}
        {topP !== undefined && <Row label="Top P">{topP}</Row>}
        {maxOutputTokens !== undefined && <Row label="Max output tokens">{maxOutputTokens}</Row>}
        {thinkingBudgetTokens !== undefined && <Row label="Thinking budget">{thinkingBudgetTokens}</Row>}
        <Row label="Filesystem">{profile.toolPolicy.fs}</Row>
        <Row label="Shell">{profile.toolPolicy.shell ? 'on' : 'off'}</Row>
        <Row label="Global memory" testId="profile-global-memory">
          {profile.useGlobalMemory === false ? 'off' : 'on'}
        </Row>
      </dl>
    </div>
  );
}
