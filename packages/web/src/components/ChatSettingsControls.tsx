import type { JSX } from 'react';
import { CLAUDE_EFFORTS, isClaudeEffort, type ClaudeEffort } from '@otherbench/core/types/config.js';
import { AccountSelect } from './AccountSelect.js';
import type { ChatSettings } from './useChatSettings.js';

const EFFORT_LABELS: Record<ClaudeEffort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max' };

export interface ChatSettingsControlsProps {
  settings: ChatSettings;
  planMode: boolean;
  showAutoToggle: boolean;
  autoActive: boolean;
  autoUnavailable: boolean;
  effort: ClaudeEffort | null;
  claudeAccount: string | null;
}

/** The composer toolbar's Plan and Auto toggles, effort and Claude account: the chat's settings for its next turns. */
export function ChatSettingsControls({ settings, planMode, showAutoToggle, autoActive, autoUnavailable, effort, claudeAccount }: ChatSettingsControlsProps): JSX.Element {
  const { planSaving, togglePlanMode, autoSaving, toggleAutoMode, effortSaving, changeEffort, accountSaving, changeAccount } = settings;
  return (
    <>
      <button
        type="button"
        aria-label="Plan mode"
        aria-pressed={planMode}
        disabled={planSaving}
        title="Plan first: the model sets out a plan and waits for your approval before it changes anything (from the next message)"
        onClick={() => void togglePlanMode()}
        className="chip shrink-0 px-2 py-0.5 font-mono text-[0.6875rem]"
      >
        Plan
      </button>

      {showAutoToggle && (
        <button
          type="button"
          aria-label="Auto mode"
          aria-pressed={autoActive}
          disabled={autoUnavailable || autoSaving}
          title={
            autoUnavailable
              ? 'Auto mode needs the Claude login'
              : autoActive
                ? 'Auto mode is on: Claude Code decides routine tool calls; your profile limits still apply.'
                : 'Let Claude Code decide routine tool calls (applies at once, even to a reply that is running)'
          }
          onClick={() => void toggleAutoMode()}
          className="chip shrink-0 px-2 py-0.5 font-mono text-[0.6875rem]"
        >
          Auto
        </button>
      )}

      {showAutoToggle && (
        <select
          aria-label="Effort"
          value={effort ?? ''}
          disabled={effortSaving}
          title="Effort: how much Claude Code thinks before it answers, from the next message. Default follows your Claude Code settings."
          onChange={(e) => void changeEffort(isClaudeEffort(e.target.value) ? e.target.value : null)}
          className={`chip shrink-0 field-sizing-content bg-[var(--bg)] px-1.5 py-0.5 font-mono text-[0.6875rem] ${effort ? 'chip-on' : ''}`}
        >
          {/* Just the level, to keep the toolbar to one line; the tooltip says what it is. */}
          <option value="">default</option>
          {CLAUDE_EFFORTS.map((level) => (
            <option key={level} value={level}>
              {EFFORT_LABELS[level]}
            </option>
          ))}
        </select>
      )}

      {/* The Claude login's accounts, so like the plan meter not for a Claude Code profile on an endpoint. */}
      {showAutoToggle && !autoUnavailable && <AccountSelect value={claudeAccount} disabled={accountSaving} onChange={(next) => void changeAccount(next)} />}
    </>
  );
}
