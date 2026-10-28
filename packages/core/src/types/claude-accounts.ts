/** Claude account logins: a chat's Claude Code turns can run on any of several logins (each its own config dir). */

export const MAIN_ACCOUNT_SLUG = 'main';

/** A stored non-main account (app_setting 'claudeAccounts'). */
export interface ClaudeAccount {
  slug: string;
  name: string;
  colour: string;
  configDir: string;
}

/** What a turn runs on. configDir null = main (inherit CLAUDE_CONFIG_DIR / ~/.claude). */
export interface ClaudeAccountRef {
  slug: string;
  name: string;
  configDir: string | null;
}

export const MAIN_ACCOUNT: ClaudeAccountRef = { slug: MAIN_ACCOUNT_SLUG, name: 'Main', configDir: null };

/** Lower-case, runs of anything but a-z and 0-9 become one dash, no leading or trailing dash. */
export function accountSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The session backend for an account: `'claude'` for main (or none), `claude:<slug>` otherwise. */
export function claudeBackend(account: ClaudeAccountRef | null | undefined): string {
  return !account || account.slug === MAIN_ACCOUNT_SLUG ? 'claude' : `claude:${account.slug}`;
}

/** True for a Claude login backend (`claude` or `claude:<slug>`), false for an endpoint URL. */
export function isClaudeLogin(backend: string): boolean {
  return backend === 'claude' || backend.startsWith('claude:');
}

/** An account as the API shows it. The login fields stay null until a login runner has read them. */
export interface AccountView {
  slug: string;
  name: string;
  colour: string | null;
  configDir: string | null;
  main: boolean;
  limitedUntil: number | null;
  signedIn: boolean | null;
  email: string | null;
  subscriptionType: string | null;
  signingIn: boolean;
}
