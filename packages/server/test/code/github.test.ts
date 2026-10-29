import { describe, expect, it } from 'vitest';
import { ExecutableMissingError, type RunResult } from '../../src/code/process.js';
import { ExecutableNotFoundError } from '@otherbench/tools/mcp/spawn.js';
import { GhError, ghEnv, ghRunner, githubService, type Runner } from '../../src/code/github.js';

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

/** A runner answering each call in turn. */
function sequence(results: RunResult[]) {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push(args);
    const r = results.shift();
    if (!r) throw new Error('no more results');
    return r;
  };
  return { run, calls };
}

describe('githubService inbox and login', () => {
  const thread = (id: number) => ({
    id: String(id), unread: true, reason: 'mention', updated_at: '2026-10-29T10:00:00Z',
    subject: { title: `t${id}`, url: `https://api.github.com/repos/o/r/issues/${id}`, type: 'Issue' }, repository: { full_name: 'o/r' },
  });
  const page = (from: number, count: number) => ok(JSON.stringify(Array.from({ length: count }, (_, i) => thread(from + i))));

  it('reads one page of the inbox, read and unread, and stops when it is not full', async () => {
    const f = sequence([page(1, 3)]);
    const out = await githubService(f.run).notifications();
    expect(f.calls).toEqual([['api', 'notifications?all=true&per_page=50&page=1']]);
    expect(out.more).toBe(false);
    expect(out.list.map((n) => n.id)).toEqual(['1', '2', '3']);
    expect(out.list[0]).toMatchObject({ repo: 'o/r', kind: 'issue', number: 1, url: 'https://github.com/o/r/issues/1' });
  });

  it('reads a second page only after a full first one, and says there is more after a full second', async () => {
    const f = sequence([page(1, 50), page(51, 50)]);
    const out = await githubService(f.run).notifications();
    expect(f.calls.map((a) => a[1])).toEqual(['notifications?all=true&per_page=50&page=1', 'notifications?all=true&per_page=50&page=2']);
    expect(out).toMatchObject({ more: true });
    expect(out.list).toHaveLength(100);
    expect((await githubService(sequence([page(1, 50), page(51, 2)]).run).notifications()).more).toBe(false);
  });

  it('drops entries it cannot read, and maps a signed-out gh', async () => {
    const f = sequence([ok(JSON.stringify([thread(1), { id: 'x' }, 'junk']))]);
    expect((await githubService(f.run).notifications()).list.map((n) => n.id)).toEqual(['1']);
    expect(await code(githubService(fake(fail('To get started with GitHub CLI, please run:  gh auth login')).run).notifications())).toBe('gh-signed-out');
    expect(await code(githubService(fake(ok('{"message":"odd"}')).run).notifications())).toBe('gh-failed');
  });

  it('marks a thread done with DELETE and read with PATCH', async () => {
    const f = fake(ok(''));
    await githubService(f.run).markDone('123');
    await githubService(f.run).markRead('456');
    expect(f.calls.map((c) => c.args)).toEqual([
      ['api', '-X', 'DELETE', 'notifications/threads/123'],
      ['api', '-X', 'PATCH', 'notifications/threads/456'],
    ]);
  });

  it('refuses a thread id that is not digits without running gh', async () => {
    const f = fake(ok(''));
    expect(await code(githubService(f.run).markDone('1/../../user'))).toBe('gh-failed');
    expect(await code(githubService(f.run).markRead(''))).toBe('gh-failed');
    expect(f.calls).toEqual([]);
  });

  it('views a pull request with its branch', async () => {
    const f = fake(ok(JSON.stringify({ number: 456, title: 'Add it', body: 'Does it', url: 'https://github.com/o/r/pull/456', headRefName: 'feat/it' })));
    expect(await githubService(f.run).pr('o/r', 456)).toEqual({ number: 456, title: 'Add it', body: 'Does it', url: 'https://github.com/o/r/pull/456', branch: 'feat/it' });
    expect(f.calls[0]!.args).toEqual(['pr', 'view', '456', '--repo', 'o/r', '--json', 'number,title,body,url,headRefName']);
    expect(await code(githubService(f.run).pr('not a repo', 1))).toBe('repo-not-found');
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
