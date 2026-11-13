import { useEffect, type JSX } from 'react';
import { defaultAccountName, showsAccountPicker, useClaudeAccounts } from '../state/claudeAccounts.js';

/**
 * Which Claude account the chat runs on, in the composer's toolbar beside
 * Effort: there in Chat and Code alike, where the Inspector's picker is a tab
 * and a closed section away in Code. Render it only for a chat on the Claude
 * login. It offers each account by name as well as the default: the default
 * (Main unless Settings sets another) overflows, a named account stays put.
 */
export function AccountSelect({ value, disabled, onChange }: { value: string | null; disabled: boolean; onChange: (slug: string | null) => void }): JSX.Element | null {
  const accounts = useClaudeAccounts((s) => s.accounts);
  const load = useClaudeAccounts((s) => s.load);
  useEffect(() => {
    if (accounts.length === 0) load().catch((err: unknown) => console.error('[otherbench-web] failed to load the Claude accounts:', err));
  }, [accounts.length, load]);
  if (!showsAccountPicker(accounts, value)) return null;
  const fallback = accounts.find((a) => a.default && !a.main);

  return (
    <select
      aria-label="Claude account"
      value={value ?? ''}
      disabled={disabled}
      title={`Claude account: which login this chat runs on, from the next message. A move starts a new Claude Code session seeded with this chat's history. The default runs on ${defaultAccountName(accounts)} and overflows to another account when that is at its limit.`}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      className={`chip max-w-40 shrink-0 field-sizing-content bg-[var(--bg)] px-1.5 py-0.5 font-mono text-[0.6875rem] ${value ? 'chip-on' : ''}`}
    >
      <option value="">{fallback ? `default account (${fallback.name})` : 'default account'}</option>
      {value && !accounts.some((a) => a.slug === value) && <option value={value}>{value} (missing)</option>}
      {accounts.map((a) => (
        <option key={a.slug} value={a.slug}>
          {a.name}
        </option>
      ))}
    </select>
  );
}
