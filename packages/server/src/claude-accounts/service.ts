import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { limitFromUsage, pickClaudeAccount } from '@otherbench/core/domain/claude-accounts.js';
import { ClaudeAccountUnavailableError } from '@otherbench/core/domain/turn.js';
import type { ChatEngine } from '@otherbench/core/ports/chat-engine.js';
import type { Store } from '@otherbench/core/ports/store.js';
import { accountSlug, MAIN_ACCOUNT, MAIN_ACCOUNT_SLUG, type ClaudeAccount, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import { PlanUsageCache, readPlanUsage } from '../plan-usage.js';
import type { AppEventBus } from '../stream/events.js';

/** The machine-local `app_setting` value the account list is kept in. Never synced: each machine has its own logins. */
const ACCOUNTS_KEY = 'claudeAccounts';
const COLOUR = /^#[0-9a-f]{6}$/i;

/** A request to add or change an account that can't be met as asked; routes answer it with 400. */
export class AccountInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountInputError';
  }
}

function isAccount(value: unknown): value is ClaudeAccount {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return typeof a['slug'] === 'string' && typeof a['name'] === 'string' && typeof a['colour'] === 'string' && typeof a['configDir'] === 'string';
}

function toRef(account: ClaudeAccount): ClaudeAccountRef {
  return { slug: account.slug, name: account.name, configDir: account.configDir };
}

/** A folder as compared with another: resolved, and case-insensitive on Windows. */
function folderKey(dir: string): string {
  const full = resolve(dir);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

function checkColour(colour: string): void {
  if (!COLOUR.test(colour)) throw new AccountInputError(`"${colour}" isn't a colour: use the form #rrggbb.`);
}

/**
 * This machine's Claude account logins besides main (spec
 * 2026-10-28-claude-accounts-design): the list, kept in the `claudeAccounts`
 * value; which account each Claude Code turn runs on; how long each is held
 * as out of usage; and each one's plan usage, read at most as often as the
 * single reading used to be.
 *
 * "Limited until" is held in memory: a restart forgets it, and the next
 * usage reading or rate-limit event sets it again.
 */
export class ClaudeAccountService {
  private readonly now: () => number;
  private readonly home: string;
  private readonly baseEnv: NodeJS.ProcessEnv;
  /** Until when each account is out of usage, and when that was learnt (so only a newer reading clears it). */
  private readonly limits = new Map<string, { until: number; at: number }>();
  private readonly usageCaches = new Map<string, PlanUsageCache>();

  constructor(private readonly deps: { store: Store; engine: ChatEngine; events: AppEventBus; now?: () => number; home?: string; baseEnv?: NodeJS.ProcessEnv }) {
    this.now = deps.now ?? Date.now;
    this.home = deps.home ?? homedir();
    this.baseEnv = deps.baseEnv ?? process.env;
  }

  /** The accounts besides main, as stored. */
  list(): ClaudeAccount[] {
    const value = this.deps.store.settings.getValue(ACCOUNTS_KEY);
    return Array.isArray(value) ? value.filter(isAccount) : [];
  }

  /** Every account a turn can run on, main first. */
  refs(): ClaudeAccountRef[] {
    return [MAIN_ACCOUNT, ...this.list().map(toRef)];
  }

  ref(slug: string): ClaudeAccountRef | null {
    return this.refs().find((r) => r.slug === slug) ?? null;
  }

  /** Adds an account. Its folder defaults to `~/.claude-<slug>`; it must be absolute, nobody else's, and not main's. */
  add(input: { name: string; colour: string; configDir?: string }): ClaudeAccount {
    const name = input.name.trim();
    if (!name) throw new AccountInputError('An account needs a name.');
    const slug = accountSlug(name);
    if (!slug) throw new AccountInputError('An account name needs a letter or a digit in it.');
    if (slug === MAIN_ACCOUNT_SLUG) throw new AccountInputError('"main" is the name of the machine\'s own Claude login: choose another.');
    checkColour(input.colour);
    const given = input.configDir?.trim();
    if (given && !isAbsolute(given)) throw new AccountInputError(`The folder "${given}" isn't a full path.`);
    const configDir = resolve(given || join(this.home, `.claude-${slug}`));

    const accounts = this.list();
    if (accounts.some((a) => a.slug === slug)) throw new AccountInputError(`There's already an account called "${name}".`);
    const key = folderKey(configDir);
    const sharing = accounts.find((a) => folderKey(a.configDir) === key);
    if (sharing) throw new AccountInputError(`The account "${sharing.name}" already uses the folder ${configDir}.`);
    if (key === folderKey(this.mainFolder())) throw new AccountInputError(`${configDir} is the folder of the machine's own Claude login (main).`);

    const account: ClaudeAccount = { slug, name, colour: input.colour, configDir };
    this.save([...accounts, account]);
    return account;
  }

  update(slug: string, patch: { colour?: string }): ClaudeAccount {
    const accounts = this.list();
    const index = accounts.findIndex((a) => a.slug === slug);
    if (index < 0) throw new AccountInputError(`No Claude account named "${slug}" on this machine.`);
    if (patch.colour !== undefined) checkColour(patch.colour);
    const account: ClaudeAccount = { ...accounts[index]!, ...(patch.colour !== undefined ? { colour: patch.colour } : {}) };
    accounts[index] = account;
    this.save(accounts);
    return account;
  }

  /** Forgets an account. Its folder (and the login in it) is left on disk; chats pinned to it fail until moved. */
  remove(slug: string): void {
    if (slug === MAIN_ACCOUNT_SLUG) throw new AccountInputError("The machine's own Claude login (main) can't be removed.");
    this.save(this.list().filter((a) => a.slug !== slug));
    this.limits.delete(slug);
    this.usageCaches.delete(slug);
  }

  /** Until when the account is out of usage (ms epoch), or null when it has room. */
  limitedUntil(slug: string): number | null {
    const limit = this.limits.get(slug);
    if (!limit) return null;
    if (limit.until <= this.now()) {
      this.limits.delete(slug);
      return null;
    }
    return limit.until;
  }

  markLimited(slug: string, until: number): void {
    this.limits.set(slug, { until, at: this.now() });
  }

  /**
   * The account's plan usage, read at most every PLAN_USAGE_MAX_AGE_MS (or
   * PLAN_USAGE_MIN_REFRESH_MS when `refresh` asks); null for an account not
   * on this machine. A reading with a full 5-hour or weekly window holds the
   * account until it resets; a reading newer than the hold that shows room
   * lets it go.
   */
  async usage(slug: string, refresh: boolean): Promise<PlanUsage | null> {
    if (!this.ref(slug)) return null;
    let cache = this.usageCaches.get(slug);
    if (!cache) {
      cache = new PlanUsageCache(async () => {
        const ref = this.ref(slug);
        return ref ? readPlanUsage(this.deps, ref) : null;
      }, this.now);
      this.usageCaches.set(slug, cache);
    }
    const usage = await cache.get(refresh);
    const held = this.limits.get(slug);
    // Only a reading newer than what's held says anything: a cached one served again, or one
    // fetched before a rate-limit event, must neither move nor clear that event's hold.
    if (usage && (!held || usage.fetchedAt > held.at)) {
      const until = limitFromUsage(usage);
      if (until !== null && until > this.now()) this.markLimited(slug, until);
      else this.limits.delete(slug);
    }
    return usage;
  }

  /**
   * The account chat `chatId`'s next turn runs on. A chat that names one runs
   * on it; one that names none runs on main, or, while main is limited, on
   * the first account with room, and is pinned to it (with a
   * `claude-account-switched` event). Throws ClaudeAccountUnavailableError
   * when the chat names an account this machine doesn't have: it never falls
   * back to main.
   */
  resolveForTurn(chatId: string): ClaudeAccountRef {
    const chat = this.deps.store.chats.get(chatId);
    const pick = this.pick(chat?.claudeAccount ?? null);
    if (pick.kind === 'missing') throw new ClaudeAccountUnavailableError(pick.slug);
    if (pick.pin && chat) {
      this.deps.store.chats.update(chatId, { claudeAccount: pick.account.slug });
      this.deps.events.emit({
        type: 'claude-account-switched',
        chatId,
        from: MAIN_ACCOUNT.name,
        to: pick.account.name,
        resetsAt: this.limitedUntil(MAIN_ACCOUNT_SLUG),
        midReply: false,
      });
    }
    return pick.account;
  }

  /** The account a turn with no chat to pin (a title, a memory summary) runs on: main, or one with room while main is limited. */
  defaultRef(): ClaudeAccountRef {
    const pick = this.pick(null);
    return pick.kind === 'ok' ? pick.account : MAIN_ACCOUNT;
  }

  private pick(chosen: string | null): ReturnType<typeof pickClaudeAccount> {
    return pickClaudeAccount({ chosen, accounts: this.refs(), limitedUntil: (slug) => this.limitedUntil(slug), now: this.now() });
  }

  /** Main's folder as Claude Code sees it: the inherited CLAUDE_CONFIG_DIR, or `~/.claude`. */
  private mainFolder(): string {
    const inherited = this.baseEnv['CLAUDE_CONFIG_DIR'];
    return inherited ? resolve(inherited) : join(this.home, '.claude');
  }

  private save(accounts: ClaudeAccount[]): void {
    this.deps.store.settings.setValue(ACCOUNTS_KEY, accounts);
  }
}
