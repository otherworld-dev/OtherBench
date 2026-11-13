/** Settings calls: app settings, the sandbox, the claude.ai import, usage and Claude accounts. */
import type { AppSettings } from '@otherbench/core/ports/store.js';
import type { UsageRollup } from '@otherbench/core/domain/usage-rollup.js';
import type { ImportPreview, ImportStart, ImportStatus } from '@otherbench/core/types/claude-import.js';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import type { SandboxStatus } from '@otherbench/core/ports/sandbox.js';
import { request, post, put, patch, del } from './http.js';

export const settingsApi = {
  get: () => request<AppSettings>('/settings'),
  patch: (body: Partial<AppSettings>) => patch<AppSettings>('/settings', body),
};

/** Settings > Sandbox (spec 2026-10-12-sandbox-design): Set up and Repair start a job (202; poll status), Remove, the extra packages (202). */
export const sandboxApi = {
  status: () => request<SandboxStatus>('/sandbox'),
  setup: () => post<SandboxStatus>('/sandbox/setup'),
  remove: () => post<SandboxStatus>('/sandbox/remove'),
  setPackages: (packages: string[]) => put<SandboxStatus>('/sandbox/packages', { packages }),
};

/** Import from claude.ai (spec 2026-10-09-claude-import-design §5): the running or last import, a preview, and a start (202). */
export const claudeImportApi = {
  status: () => request<ImportStatus>('/import/claude'),
  preview: (folder: string, profileId: string | null) => post<ImportPreview>('/import/claude/preview', { folder, profileId }),
  start: (body: ImportStart) => post<ImportStatus>('/import/claude', body),
};

export const usageApi = {
  /** Omit `chatId` for the global (every-chat) rollup the usage/pricing settings view shows. */
  get: (chatId?: string) => request<UsageRollup>(`/usage${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`),
};

export const claudeApi = {
  /** The Claude login's plan usage (Deck #825), null when there's no plan to show. `refresh` asks for a fresher reading, as after a reply. */
  planUsage: (refresh = false, account?: string) => {
    const q = [...(account ? [`account=${encodeURIComponent(account)}`] : []), ...(refresh ? ['refresh=1'] : [])];
    return request<{ usage: PlanUsage | null }>(`/claude/plan-usage${q.length ? `?${q.join('&')}` : ''}`);
  },
  /** Claude account logins: each its own config folder. Main comes first. */
  accounts: {
    list: () => request<{ accounts: AccountView[] }>('/claude/accounts'),
    add: (body: { name: string; colour: string; configDir?: string }) => post<{ account: AccountView }>('/claude/accounts', body),
    update: (slug: string, body: { colour: string }) => patch<{ account: AccountView }>(`/claude/accounts/${encodeURIComponent(slug)}`, body),
    remove: (slug: string) => del(`/claude/accounts/${encodeURIComponent(slug)}`),
    /** Makes `slug` the account Default chats run on (main puts it back). */
    setDefault: (slug: string) => put<void>('/claude/accounts/default', { slug }),
    /** Starts the CLI's sign-in (202); `url` is the page to open, null if none came. */
    signIn: (slug: string) => post<{ url: string | null }>(`/claude/accounts/${encodeURIComponent(slug)}/sign-in`),
    /** The code the sign-in page shows, for a CLI that can't be reached by its callback. */
    submitCode: (slug: string, code: string) => post<void>(`/claude/accounts/${encodeURIComponent(slug)}/sign-in/code`, { code }),
    /** Ends the sign-in running for an account, so another can be started. */
    cancelSignIn: (slug: string) => post<void>(`/claude/accounts/${encodeURIComponent(slug)}/sign-in/cancel`),
    signOut: (slug: string) => post<void>(`/claude/accounts/${encodeURIComponent(slug)}/sign-out`),
  },
};
