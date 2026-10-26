import { describe, expect, it } from 'vitest';
import { ExecutableMissingError, type RunResult } from '../../src/code/process.js';
import { ExecutableNotFoundError } from '@otherbench/tools/mcp/spawn.js';
import { issueNeed } from '@otherbench/core/domain/overview.js';
import { ACTIVITY_QUERY, GhError, ghEnv, ghRunner, githubService, type Runner } from '../../src/code/github.js';

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr, timedOut: false, truncated: false });

function fake(result: RunResult | Error) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: Runner = async (args, input) => {
    calls.push({ args, ...(input !== undefined ? { input } : {}) });
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls };
}
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof GhError ? e.code : `other:${String(e)}`;
  }
  return 'none';
}

const raw = (n: number, createdAt: string) => ({
  number: n,
  title: `t${n}`,
  state: 'OPEN',
  author: { login: 'adam' },
  labels: [{ name: 'bug' }, { name: 'ui' }],
  comments: [{ author: { login: 'x' }, body: 'hi', createdAt }],
  createdAt,
  updatedAt: createdAt,
  url: `https://github.com/o/r/issues/${n}`,
});

describe('githubService', () => {
  it('list maps fields and sorts newest first', async () => {
    const f = fake(ok(JSON.stringify([raw(1, '2026-01-01T00:00:00Z'), raw(2, '2026-02-01T00:00:00Z')])));
    const out = await githubService(f.run).list('o/r', 'open');
    expect(out.map((i) => i.number)).toEqual([2, 1]);
    expect(out[0]).toMatchObject({ author: 'adam', labels: ['bug', 'ui'], comments: 1, state: 'open' });
    expect(f.calls[0]!.args.slice(0, 6)).toEqual(['issue', 'list', '--repo', 'o/r', '--state', 'open']);
    expect(f.calls[0]!.args).toContain('--limit');
  });

  it('view maps the comment list', async () => {
    const f = fake(ok(JSON.stringify({ ...raw(3, '2026-03-01T00:00:00Z'), state: 'CLOSED', body: 'B' })));
    const d = await githubService(f.run).view('o/r', 3);
    expect(d.body).toBe('B');
    expect(d.state).toBe('closed');
    expect(d.commentList).toEqual([{ author: 'x', body: 'hi', createdAt: '2026-03-01T00:00:00Z' }]);
    expect(f.calls[0]!.args.slice(0, 4)).toEqual(['issue', 'view', '3', '--repo']);
  });

  it('comment sends the body on stdin, not argv', async () => {
    const f = fake(ok(''));
    await githubService(f.run).comment('o/r', 4, 'secret body');
    expect(f.calls[0]!.input).toBe('secret body');
    expect(f.calls[0]!.args.join(' ')).not.toContain('secret body');
    expect(f.calls[0]!.args).toContain('--body-file');
  });

  it('close and reopen run the matching verbs', async () => {
    const f = fake(ok(''));
    await githubService(f.run).close('o/r', 5);
    await githubService(f.run).reopen('o/r', 5);
    expect(f.calls.map((c) => c.args[1])).toEqual(['close', 'reopen']);
  });

  it('maps errors', async () => {
    const svc = (r: RunResult | Error) => githubService(fake(r).run);
    expect(await code(svc(new ExecutableMissingError('gh')).list('o/r', 'open'))).toBe('gh-missing');
    expect(await code(svc(fail('To get started with GitHub CLI, please run:  gh auth login')).list('o/r', 'open'))).toBe('gh-signed-out');
    expect(await code(svc(fail('GraphQL: Could not resolve to a Repository with the name o/r')).list('o/r', 'open'))).toBe('repo-not-found');
    expect(await code(svc(fail('boom\nmore')).list('o/r', 'open'))).toBe('gh-failed');
    expect(await code(svc({ ...fail(''), timedOut: true }).list('o/r', 'open'))).toBe('gh-failed');
  });

  it('gh-failed carries the first stderr line, redacted', async () => {
    const f = fake(fail('failed https://user:tok@github.com/x\nsecond'));
    const err = await githubService(f.run).list('o/r', 'open').catch((e: unknown) => e as GhError);
    expect(err.message).toBe('failed https://github.com/x');
    // The whole stderr too, redacted, for the panel to show as-is (spec "Error states").
    expect(err.stderr).toBe('failed https://github.com/x\nsecond');
  });

  it('a gh that cannot be started for another reason is gh-failed, not a raw error', async () => {
    const f = fake(Object.assign(new Error('spawn EINVAL https://user:tok@github.com/x'), { code: 'EINVAL' }));
    const err = await githubService(f.run).list('o/r', 'open').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhError);
    expect((err as GhError).code).toBe('gh-failed');
    expect((err as GhError).message).toBe('Could not start gh: spawn EINVAL https://github.com/x');
  });

  it('refuses a bad repo or number without running', async () => {
    const f = fake(ok('[]'));
    const svc = githubService(f.run);
    expect(await code(svc.list('a/../b', 'open'))).toBe('repo-not-found');
    expect(await code(svc.view('o/r', 0))).toBe('gh-failed');
    expect(await code(svc.close('o/r', 1.5))).toBe('gh-failed');
    expect(f.calls).toHaveLength(0);
  });
});

describe('ghEnv', () => {
  it('drops server secrets and switches off prompts', () => {
    const env = ghEnv({ PATH: 'p', OTHERBENCH_TOKEN: 'x' });
    expect(env.PATH).toBe('p');
    expect(env.OTHERBENCH_TOKEN).toBeUndefined();
    expect(env.GH_PROMPT_DISABLED).toBe('1');
    expect(env.GH_NO_UPDATE_NOTIFIER).toBe('1');
    expect(env.NO_COLOR).toBe('1');
  });
});

describe('ghRunner (M5)', () => {
  it('resolves gh once and reuses the path, rather than a synchronous `where` per call', async () => {
    let resolved = 0;
    // node stands in for gh, so the runner really spawns what the resolver returned.
    const run = ghRunner(() => {
      resolved += 1;
      return process.execPath;
    });
    const a = await run(['-e', 'process.stdout.write("1")']);
    const b = await run(['-e', 'process.stdout.write("2")']);
    expect([a.stdout, b.stdout]).toEqual(['1', '2']);
    expect(resolved).toBe(1);
  });

  it('a gh that is not found is gh-missing, and is looked for again next time', async () => {
    let resolved = 0;
    const run = ghRunner(() => {
      resolved += 1;
      throw new ExecutableNotFoundError('gh');
    });
    expect(await code(run(['--version']))).toBe('gh-missing');
    expect(await code(run(['--version']))).toBe('gh-missing');
    expect(resolved).toBe(2);
  });
});

describe('githubService activity and login', () => {
  /** gh api graphql's real response shape (checked live against actions/stale): bots carry `__typename: 'Bot'`, no `[bot]`. */
  const gql = (nodes: unknown[]) => JSON.stringify({ data: { repository: { issues: { nodes } } } });
  const user = (login: string) => ({ __typename: 'User', login });
  const bot = (login: string) => ({ __typename: 'Bot', login });

  it('activity runs one constant GraphQL query with owner and name as variables', async () => {
    const f = fake(ok(gql([])));
    await githubService(f.run).activity('evil-owner/evil.name');
    expect(f.calls[0]!.args).toEqual(['api', 'graphql', '-f', `query=${ACTIVITY_QUERY}`, '-f', 'owner=evil-owner', '-f', 'name=evil.name']);
    expect(ACTIVITY_QUERY).not.toContain('evil');
    expect(ACTIVITY_QUERY).toContain('issues(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}, states: [OPEN, CLOSED])');
    expect(ACTIVITY_QUERY).toContain('comments(last: 100)');
    expect(ACTIVITY_QUERY).toContain('__typename');
  });

  it('activity maps authors, bots by __typename or login, ghosts and closedAt', async () => {
    const nodes = [
      {
        number: 1, title: 'a', state: 'OPEN', url: 'u1', createdAt: '2026-01-01T00:00:00Z', closedAt: null, author: user('adam'),
        comments: {
          nodes: [
            { author: bot('github-actions'), createdAt: '2026-01-02T00:00:00Z' },
            { author: user('dependabot[bot]'), createdAt: '2026-01-03T00:00:00Z' },
            { author: user('adam'), createdAt: '2026-01-04T00:00:00Z' },
            { author: null, createdAt: '2026-01-05T00:00:00Z' },
          ],
        },
      },
      { number: 2, title: 'b', state: 'CLOSED', url: 'u2', createdAt: '2026-02-01T00:00:00Z', closedAt: '2026-02-02T00:00:00Z', author: bot('renovate'), comments: { nodes: [] } },
      { number: 3, title: 'c', state: 'OPEN', url: 'u3', createdAt: '2026-03-01T00:00:00Z', closedAt: null, author: null, comments: { nodes: [] } },
    ];
    const out = await githubService(fake(ok(gql(nodes))).run).activity('o/r');
    expect(out[0]).toMatchObject({ number: 1, title: 'a', state: 'open', author: 'adam', authorIsBot: false, createdAt: '2026-01-01T00:00:00Z', closedAt: null, url: 'u1' });
    expect(out[0]!.comments).toEqual([
      { author: 'github-actions', authorIsBot: true, createdAt: '2026-01-02T00:00:00Z' },
      { author: 'dependabot[bot]', authorIsBot: true, createdAt: '2026-01-03T00:00:00Z' },
      { author: 'adam', authorIsBot: false, createdAt: '2026-01-04T00:00:00Z' },
      { author: 'ghost', authorIsBot: false, createdAt: '2026-01-05T00:00:00Z' },
    ]);
    expect(out[1]).toMatchObject({ state: 'closed', author: 'renovate', authorIsBot: true, closedAt: '2026-02-02T00:00:00Z', comments: [] });
    expect(out[2]).toMatchObject({ author: 'ghost', authorIsBot: false });
  });

  it("a github-actions comment (gh's real shape) does not make an issue need the user", async () => {
    const nodes = [
      {
        number: 9, title: 'stale', state: 'OPEN', url: 'u9', createdAt: '2026-01-01T00:00:00Z', closedAt: null, author: user('me'),
        comments: { nodes: [{ author: bot('github-actions'), createdAt: '2026-01-02T00:00:00Z' }] },
      },
    ];
    const [activity] = await githubService(fake(ok(gql(nodes))).run).activity('o/r');
    expect(issueNeed(activity!, 'me', null)).toBeNull();
  });

  it('activity maps a signed-out gh, an unknown repo, and refuses a bad repo without running gh', async () => {
    expect(await code(githubService(fake(fail('To get started with GitHub CLI, please run:  gh auth login')).run).activity('o/r'))).toBe('gh-signed-out');
    expect(await code(githubService(fake(fail("gh: Could not resolve to a Repository with the name 'o/nope'.")).run).activity('o/nope'))).toBe('repo-not-found');
    expect(await code(githubService(fake(ok(JSON.stringify({ data: { repository: null } }))).run).activity('o/r'))).toBe('repo-not-found');
    expect(await code(githubService(fake(ok('not json')).run).activity('o/r'))).toBe('gh-failed');
    const f = fake(ok(gql([])));
    expect(await code(githubService(f.run).activity('not a repo'))).toBe('repo-not-found');
    expect(f.calls).toEqual([]);
  });

  it('login runs gh api user and trims the output', async () => {
    const f = fake(ok('adam\n'));
    expect(await githubService(f.run).login()).toBe('adam');
    expect(f.calls[0]!.args).toEqual(['api', 'user', '--jq', '.login']);
  });

  it('login with empty output is gh-failed, and a signed-out gh is gh-signed-out', async () => {
    expect(await code(githubService(fake(ok('\n')).run).login())).toBe('gh-failed');
    expect(await code(githubService(fake(fail('not logged in')).run).login())).toBe('gh-signed-out');
  });
});
