import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';
import type { Connection } from '@otherbench/core/types/config.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import { createApp } from '../../src/app.js';
import { ClaudeAccountService } from '../../src/claude-accounts/service.js';
import { AppEventBus } from '../../src/stream/events.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const usage: PlanUsage = { fetchedAt: 5, windows: [{ id: 'seven_day', label: 'Weekly', percent: 80, resetsAt: null }] };

let container: Container;
let planUsage: ReturnType<typeof vi.fn<(conn: Connection) => Promise<PlanUsage | null>>>;

beforeEach(() => {
  const store = new InMemoryStore();
  planUsage = vi.fn(async () => usage);
  const engine = Object.assign(new FakeChatEngine([]), { planUsage });
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };
});

function connection(id: string, kind: Connection['kind'], baseUrl: string | null = null): void {
  container.store.connections.create({ id, name: id, kind, baseUrl, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
}

describe('GET /api/claude/plan-usage', () => {
  it('reads it through a Claude Code connection that uses the Claude login, and serves the reading again', async () => {
    connection('ollama-cc', 'claude_code', 'http://localhost:11434');
    connection('mock', 'mock');
    connection('cc', 'claude_code');
    const app = createApp(container);

    const res = await app.request('/api/claude/plan-usage');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ usage });
    expect(planUsage).toHaveBeenCalledTimes(1);
    expect(planUsage.mock.calls[0]![0].id).toBe('cc');

    // Within 30 s even a refresh is served from the last reading.
    expect(await (await app.request('/api/claude/plan-usage?refresh=1')).json()).toEqual({ usage });
    expect(planUsage).toHaveBeenCalledTimes(1);
  });

  it('is null, without asking the engine, when no connection uses the Claude login', async () => {
    connection('ollama-cc', 'claude_code', 'http://localhost:11434');
    const res = await createApp(container).request('/api/claude/plan-usage');
    expect(await res.json()).toEqual({ usage: null });
    expect(planUsage).not.toHaveBeenCalled();
  });
});

describe('Claude account routes', () => {
  const vh = { name: 'VH', colour: '#e0a030' };

  function withAccounts() {
    container.claudeAccounts = new ClaudeAccountService({ store: container.store, engine: container.engine, events: new AppEventBus(), home: 'C:\home' });
    return createApp(container);
  }
  const send = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('lists main first, without a folder', async () => {
    const app = withAccounts();
    const { accounts } = (await (await app.request('/api/claude/accounts')).json()) as { accounts: AccountView[] };
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ slug: 'main', name: 'Main', colour: null, configDir: null, main: true, limitedUntil: null, signedIn: null, email: null, subscriptionType: null, signingIn: false });
  });

  it('rejects a relative folder with 400 and adds an account with 201', async () => {
    const app = withAccounts();
    expect((await send(app, 'POST', '/api/claude/accounts', { ...vh, configDir: 'relative' })).status).toBe(400);
    const res = await send(app, 'POST', '/api/claude/accounts', vh);
    expect(res.status).toBe(201);
    const { account } = (await res.json()) as { account: AccountView };
    expect(account).toMatchObject({ slug: 'vh', name: 'VH', colour: '#e0a030', main: false });
    const list = (await (await app.request('/api/claude/accounts')).json()) as { accounts: AccountView[] };
    expect(list.accounts.map((a) => a.slug)).toEqual(['main', 'vh']);
  });

  it('changes the colour, and 404s an unknown slug', async () => {
    const app = withAccounts();
    await send(app, 'POST', '/api/claude/accounts', vh);
    const res = await send(app, 'PATCH', '/api/claude/accounts/vh', { colour: '#112233' });
    expect(((await res.json()) as { account: AccountView }).account.colour).toBe('#112233');
    expect((await send(app, 'PATCH', '/api/claude/accounts/vh', { colour: 'red' })).status).toBe(400);
    expect((await send(app, 'PATCH', '/api/claude/accounts/nope', { colour: '#112233' })).status).toBe(404);
  });

  it('refuses to delete main, deletes others, and 404s an unknown slug', async () => {
    const app = withAccounts();
    await send(app, 'POST', '/api/claude/accounts', vh);
    expect((await send(app, 'DELETE', '/api/claude/accounts/main')).status).toBe(400);
    expect((await send(app, 'DELETE', '/api/claude/accounts/nope')).status).toBe(404);
    expect((await send(app, 'DELETE', '/api/claude/accounts/vh')).status).toBe(204);
    expect(container.claudeAccounts!.ref('vh')).toBeNull();
  });

  it('keeps a chat pinned to a deleted account', async () => {
    const app = withAccounts();
    await send(app, 'POST', '/api/claude/accounts', vh);
    const chat = container.store.chats.create({ profileId: 'p', title: 't' } as never);
    container.store.chats.update(chat.id, { claudeAccount: 'vh' });
    await send(app, 'DELETE', '/api/claude/accounts/vh');
    expect(container.store.chats.get(chat.id)?.claudeAccount).toBe('vh');
  });

  it('reads plan usage through the account asked for', async () => {
    connection('cc', 'claude_code');
    const app = withAccounts();
    await send(app, 'POST', '/api/claude/accounts', vh);
    const res = await app.request('/api/claude/plan-usage?account=vh');
    expect(await res.json()).toEqual({ usage });
    expect(planUsage.mock.calls[0]![1]).toMatchObject({ slug: 'vh', configDir: expect.any(String) });
    expect((await app.request('/api/claude/plan-usage?account=nope')).status).toBe(404);
  });
  describe('sign-in', () => {
    function fakeLogin(over: Record<string, unknown> = {}) {
      const login = {
        status: vi.fn(async (ref: { slug: string }) => (ref.slug === 'vh' ? { signedIn: true, email: 'a@b.c', subscriptionType: 'max' } : { signedIn: false, email: null, subscriptionType: null })),
        signIn: vi.fn(async () => ({ started: true, url: 'https://claude.com/cai/oauth/authorize?x=1' })),
        signingIn: vi.fn((slug: string) => slug === 'vh'),
        submitCode: vi.fn(() => true),
        signOut: vi.fn(async () => {}),
        ...over,
      };
      container.claudeLogin = login as never;
      return login;
    }

    it('fills signedIn, email, subscriptionType and signingIn from the runner, and leaves null where it fails', async () => {
      fakeLogin({ status: vi.fn(async (ref: { slug: string }) => { if (ref.slug === 'main') throw new Error('stuck'); return { signedIn: true, email: 'a@b.c', subscriptionType: 'max' }; }) });
      const app = withAccounts();
      await send(app, 'POST', '/api/claude/accounts', vh);
      const { accounts } = (await (await app.request('/api/claude/accounts')).json()) as { accounts: AccountView[] };
      expect(accounts[0]).toMatchObject({ slug: 'main', signedIn: null, email: null, signingIn: false });
      expect(accounts[1]).toMatchObject({ slug: 'vh', signedIn: true, email: 'a@b.c', subscriptionType: 'max', signingIn: true });
    });

    it('starts a sign-in with 202 and the link, 404 for an unknown account', async () => {
      const login = fakeLogin();
      const app = withAccounts();
      await send(app, 'POST', '/api/claude/accounts', vh);
      const res = await send(app, 'POST', '/api/claude/accounts/vh/sign-in');
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ url: 'https://claude.com/cai/oauth/authorize?x=1' });
      expect(login.signIn.mock.calls[0]![0]).toMatchObject({ slug: 'vh' });
      expect((await send(app, 'POST', '/api/claude/accounts/nope/sign-in')).status).toBe(404);
    });

    it('passes a pasted code on (204), 409 when no login runs, 400 without one', async () => {
      const login = fakeLogin();
      const app = withAccounts();
      await send(app, 'POST', '/api/claude/accounts', vh);
      expect((await send(app, 'POST', '/api/claude/accounts/vh/sign-in/code', { code: 'abc' })).status).toBe(204);
      expect(login.submitCode).toHaveBeenCalledWith('vh', 'abc');
      expect((await send(app, 'POST', '/api/claude/accounts/vh/sign-in/code', {})).status).toBe(400);
      login.submitCode.mockReturnValue(false);
      expect((await send(app, 'POST', '/api/claude/accounts/vh/sign-in/code', { code: 'abc' })).status).toBe(409);
    });

    it('signs out with 204', async () => {
      const login = fakeLogin();
      const app = withAccounts();
      await send(app, 'POST', '/api/claude/accounts', vh);
      expect((await send(app, 'POST', '/api/claude/accounts/vh/sign-out')).status).toBe(204);
      expect(login.signOut).toHaveBeenCalledTimes(1);
    });

    it('answers 502 when sign-out fails', async () => {
      fakeLogin({ signOut: vi.fn(async () => { throw new Error('boom'); }) });
      const app = withAccounts();
      await send(app, 'POST', '/api/claude/accounts', vh);
      expect((await send(app, 'POST', '/api/claude/accounts/vh/sign-out')).status).toBe(502);
    });

    it('ends the pending sign-in when the account is deleted', async () => {
      const login = fakeLogin({ cancel: vi.fn() });
      const app = withAccounts();
      await send(app, 'POST', '/api/claude/accounts', vh);
      expect((await send(app, 'DELETE', '/api/claude/accounts/vh')).status).toBe(204);
      expect(login.cancel).toHaveBeenCalledWith('vh');
    });

    it('is 503 without a runner', async () => {
      const app = withAccounts();
      await send(app, 'POST', '/api/claude/accounts', vh);
      expect((await send(app, 'POST', '/api/claude/accounts/vh/sign-in')).status).toBe(503);
    });
  });
});
