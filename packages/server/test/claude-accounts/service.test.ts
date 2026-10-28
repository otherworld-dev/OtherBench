import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'node:path';
import { ClaudeAccountUnavailableError } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Connection } from '@otherbench/core/types/config.js';
import { MAIN_ACCOUNT, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import { AccountInputError, ClaudeAccountService } from '../../src/claude-accounts/service.js';
import { PLAN_USAGE_MAX_AGE_MS } from '../../src/plan-usage.js';
import { AppEventBus } from '../../src/stream/events.js';

const home = process.platform === 'win32' ? 'C:\\h' : '/h';
const T0 = 1_800_000_000_000;

let store: InMemoryStore;
let events: AppEvent[];
let clock: number;
let reading: PlanUsage | null;
let planUsage: ReturnType<typeof vi.fn<(conn: Connection, account?: ClaudeAccountRef) => Promise<PlanUsage | null>>>;

function service(baseEnv: NodeJS.ProcessEnv = {}): ClaudeAccountService {
  const bus = new AppEventBus();
  bus.subscribe((e) => events.push(e));
  const engine = Object.assign(new FakeChatEngine([]), { planUsage });
  return new ClaudeAccountService({ store, engine, events: bus, now: () => clock, home, baseEnv });
}

function chat(id: string, claudeAccount: string | null): void {
  store.chats.create({ id, title: 'T', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, claudeAccount });
}

beforeEach(() => {
  store = new InMemoryStore();
  store.connections.create({ id: 'cc', name: 'cc', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  events = [];
  clock = T0;
  reading = { fetchedAt: T0, windows: [{ id: 'seven_day', label: 'Weekly', percent: 40, resetsAt: null }] };
  planUsage = vi.fn(async () => reading);
});

describe('ClaudeAccountService accounts', () => {
  it("adds an account in a folder named after it in the home folder, and keeps it in the 'claudeAccounts' value", () => {
    const accounts = service();
    const vh = accounts.add({ name: 'VH', colour: '#e0a030' });
    expect(vh).toEqual({ slug: 'vh', name: 'VH', colour: '#e0a030', configDir: join(home, '.claude-vh') });
    expect(store.settings.getValue('claudeAccounts')).toEqual([vh]);
    expect(accounts.list()).toEqual([vh]);
    expect(accounts.refs()).toEqual([MAIN_ACCOUNT, { slug: 'vh', name: 'VH', configDir: vh.configDir }]);
    expect(accounts.ref('vh')).toEqual({ slug: 'vh', name: 'VH', configDir: vh.configDir });
    expect(accounts.ref('main')).toEqual(MAIN_ACCOUNT);
    expect(accounts.ref('nope')).toBeNull();
  });

  it('refuses a relative folder, a bad colour, an empty name and the name main', () => {
    const accounts = service();
    expect(() => accounts.add({ name: 'VH', colour: '#e0a030', configDir: 'relative' })).toThrow(AccountInputError);
    expect(() => accounts.add({ name: 'VH', colour: 'orange' })).toThrow(AccountInputError);
    expect(() => accounts.add({ name: '  ', colour: '#e0a030' })).toThrow(AccountInputError);
    expect(() => accounts.add({ name: 'Main', colour: '#e0a030' })).toThrow(AccountInputError);
    expect(accounts.list()).toEqual([]);
  });

  it('refuses a duplicate name or folder', () => {
    const accounts = service();
    accounts.add({ name: 'VH', colour: '#e0a030' });
    expect(() => accounts.add({ name: 'vh', colour: '#112233', configDir: join(home, 'other') })).toThrow(AccountInputError);
    expect(() => accounts.add({ name: 'Work', colour: '#112233', configDir: join(home, '.claude-vh') })).toThrow(AccountInputError);
    if (process.platform === 'win32') {
      expect(() => accounts.add({ name: 'Work', colour: '#112233', configDir: 'c:\\H\\.Claude-VH\\' })).toThrow(AccountInputError);
    }
    expect(accounts.list()).toHaveLength(1);
  });

  it("refuses an account at main's folder", () => {
    const vhDir = join(home, '.claude-vh');
    expect(() => service({ CLAUDE_CONFIG_DIR: vhDir }).add({ name: 'VH', colour: '#e0a030', configDir: vhDir })).toThrow(AccountInputError);
    // With CLAUDE_CONFIG_DIR set, ~/.claude is not main's folder.
    expect(service({ CLAUDE_CONFIG_DIR: vhDir }).add({ name: 'Old', colour: '#e0a030', configDir: join(home, '.claude') }).slug).toBe('old');
    store.settings.setValue('claudeAccounts', null);
    expect(() => service().add({ name: 'Work', colour: '#e0a030', configDir: join(home, '.claude') })).toThrow(AccountInputError);
  });

  it('changes a colour, forgets an account, and never removes main', () => {
    const accounts = service();
    accounts.add({ name: 'VH', colour: '#e0a030' });
    expect(accounts.update('vh', { colour: '#00aa88' }).colour).toBe('#00aa88');
    expect(() => accounts.update('vh', { colour: 'teal' })).toThrow(AccountInputError);
    expect(() => accounts.update('nope', { colour: '#00aa88' })).toThrow(AccountInputError);
    expect(() => accounts.remove('main')).toThrow(AccountInputError);
    accounts.remove('vh');
    expect(accounts.list()).toEqual([]);
  });
});

describe('ClaudeAccountService limits', () => {
  it('holds an account limited until the time given, then not', () => {
    const accounts = service();
    expect(accounts.limitedUntil('main')).toBeNull();
    accounts.markLimited('main', T0 + 60_000);
    expect(accounts.limitedUntil('main')).toBe(T0 + 60_000);
    clock = T0 + 60_000;
    expect(accounts.limitedUntil('main')).toBeNull();
  });
});

describe('ClaudeAccountService.resolveForTurn', () => {
  it('runs a chat with no account on main while main has room, and leaves the chat as it is', () => {
    const accounts = service();
    accounts.add({ name: 'VH', colour: '#e0a030' });
    chat('c1', null);
    expect(accounts.resolveForTurn('c1')).toEqual(MAIN_ACCOUNT);
    expect(store.chats.get('c1')!.claudeAccount).toBeNull();
    expect(events.filter((e) => e.type === 'claude-account-switched')).toEqual([]);
  });

  it('moves a chat with no account onto another account once main is limited, and says so', () => {
    const accounts = service();
    const vh = accounts.add({ name: 'VH', colour: '#e0a030' });
    chat('c1', null);
    accounts.markLimited('main', T0 + 60_000);
    expect(accounts.resolveForTurn('c1')).toEqual({ slug: 'vh', name: 'VH', configDir: vh.configDir });
    expect(store.chats.get('c1')!.claudeAccount).toBe('vh');
    expect(events.filter((e) => e.type === 'claude-account-switched')).toEqual([
      { type: 'claude-account-switched', chatId: 'c1', from: 'Main', to: 'VH', midReply: false, resetsAt: T0 + 60_000 },
    ]);
  });

  it("runs a chat on the account it names, and fails one whose account isn't on this machine", () => {
    const accounts = service();
    accounts.add({ name: 'VH', colour: '#e0a030' });
    chat('c1', 'vh');
    chat('c2', 'gone');
    expect(accounts.resolveForTurn('c1').slug).toBe('vh');
    expect(() => accounts.resolveForTurn('c2')).toThrow(ClaudeAccountUnavailableError);
    expect(() => accounts.resolveForTurn('c2')).toThrow('No Claude account named "gone" on this machine.');
  });

  it('gives the default pick without pinning anything', () => {
    const accounts = service();
    accounts.add({ name: 'VH', colour: '#e0a030' });
    expect(accounts.defaultRef()).toEqual(MAIN_ACCOUNT);
    accounts.markLimited('main', T0 + 60_000);
    expect(accounts.defaultRef().slug).toBe('vh');
    expect(events).toEqual([]);
  });
});

describe('ClaudeAccountService.usage', () => {
  it("marks an account limited until its full window's reset", async () => {
    reading = { fetchedAt: T0, windows: [{ id: 'five_hour', label: '5-hour', percent: 100, resetsAt: T0 + 3_600_000 }] };
    const accounts = service();
    expect(await accounts.usage('main', false)).toEqual(reading);
    expect(planUsage.mock.calls[0]![0].id).toBe('cc');
    expect(planUsage.mock.calls[0]![1]).toEqual(MAIN_ACCOUNT);
    expect(accounts.limitedUntil('main')).toBe(T0 + 3_600_000);
  });

  it('reads each account once within five minutes', async () => {
    const accounts = service();
    const vh = accounts.add({ name: 'VH', colour: '#e0a030' });
    await accounts.usage('main', false);
    clock = T0 + PLAN_USAGE_MAX_AGE_MS - 1;
    await accounts.usage('main', false);
    expect(planUsage).toHaveBeenCalledTimes(1);
    await accounts.usage('vh', false);
    expect(planUsage).toHaveBeenCalledTimes(2);
    expect(planUsage.mock.calls[1]![1]).toEqual({ slug: 'vh', name: 'VH', configDir: vh.configDir });
    expect(accounts.limitedUntil('main')).toBeNull();
  });

  it('lets a hold go on a newer reading with room, but not on one read before it', async () => {
    const accounts = service();
    await accounts.usage('main', false); // fetched at T0, with room
    clock = T0 + 1_000;
    accounts.markLimited('main', T0 + 3_600_000); // a rate-limit event after that reading
    await accounts.usage('main', false); // the T0 reading again, from the cache
    expect(accounts.limitedUntil('main')).toBe(T0 + 3_600_000);

    clock = T0 + PLAN_USAGE_MAX_AGE_MS;
    reading = { fetchedAt: clock, windows: [{ id: 'five_hour', label: '5-hour', percent: 30, resetsAt: null }] };
    await accounts.usage('main', false);
    expect(planUsage).toHaveBeenCalledTimes(2);
    expect(accounts.limitedUntil('main')).toBeNull();
  });

  it('is null for an account not on this machine', async () => {
    expect(await service().usage('gone', false)).toBeNull();
    expect(planUsage).not.toHaveBeenCalled();
  });
});
