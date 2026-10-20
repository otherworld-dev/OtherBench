import type { GitFileChange, GitStatus } from '@otherbench/core/types/code.js';

/**
 * Parsers for the git output the Code tab reads (spec 2026-10-20-code-tab-design,
 * Goal 2). All of it is machine-readable output git promises to keep stable
 * (`--porcelain=v2 -z`, `--format`), never the human text, so a git upgrade or a
 * locale change cannot change what these see.
 */

/** XY from porcelain v2 uses '.' for unchanged; the UI shape uses ' '. */
const letter = (c: string | undefined): string => (!c || c === '.' ? ' ' : c);

/**
 * `git status --porcelain=v2 --branch -z`. Records are NUL-separated, so paths
 * with spaces or newlines arrive verbatim. A rename/copy record ("2 ...") is
 * followed by one extra NUL-separated record holding the original path.
 * Ignored entries ("!") are skipped.
 */
export function parseStatusV2(out: string): GitStatus {
  const status: GitStatus = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] ?? '';
    if (rec === '') continue;
    if (rec.startsWith('# ')) {
      const space = rec.indexOf(' ', 2);
      const key = space === -1 ? rec.slice(2) : rec.slice(2, space);
      const value = space === -1 ? '' : rec.slice(space + 1);
      if (key === 'branch.head') {
        if (value === '(detached)') status.detached = true;
        else status.branch = value;
      } else if (key === 'branch.upstream') {
        status.upstream = value;
      } else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = rec[0];
    if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path   (8 fields, then the path)
      const f = splitFields(rec, 8);
      if (f) status.files.push({ path: f.path, index: letter(f.head[1]?.[0]), worktree: letter(f.head[1]?.[1]) });
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path <NUL> origPath   (9 fields, then the path)
      const f = splitFields(rec, 9);
      const orig = records[++i];
      if (f) {
        const change: GitFileChange = { path: f.path, index: letter(f.head[1]?.[0]), worktree: letter(f.head[1]?.[1]) };
        if (orig) change.origPath = orig;
        status.files.push(change);
      }
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path   (10 fields, then the path)
      const f = splitFields(rec, 10);
      if (f) status.files.push({ path: f.path, index: letter(f.head[1]?.[0]), worktree: letter(f.head[1]?.[1]) });
    } else if (kind === '?') {
      status.files.push({ path: rec.slice(2), index: '?', worktree: '?' });
    }
    // '!' (ignored) and anything unknown: skipped.
  }
  return status;
}

/** Splits `n` space-separated leading fields off a record; the rest, spaces and all, is the path. */
function splitFields(rec: string, n: number): { head: string[]; path: string } | null {
  const head: string[] = [];
  let pos = 0;
  for (let k = 0; k < n; k++) {
    const sp = rec.indexOf(' ', pos);
    if (sp === -1) return null;
    head.push(rec.slice(pos, sp));
    pos = sp + 1;
  }
  return { head, path: rec.slice(pos) };
}

/** `git branch --format=%(HEAD)%00%(refname:short)`: one "*" or " ", a NUL, the name, per line. */
export function parseBranches(out: string): { name: string; current: boolean }[] {
  const branches: { name: string; current: boolean }[] = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const nul = line.indexOf('\0');
    if (nul === -1) continue;
    const name = line.slice(nul + 1);
    // A detached HEAD shows up as "(HEAD detached at ...)"; it is not a branch to switch to.
    if (name === '' || name.startsWith('(')) continue;
    branches.push({ name, current: line.slice(0, nul) === '*' });
  }
  return branches;
}

/** `git remote -v`: "name<TAB>url (fetch|push)". Only the fetch lines are kept. */
export function parseRemotes(out: string): { name: string; url: string }[] {
  const remotes: { name: string; url: string }[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\t(.*) \(fetch\)$/.exec(line.trimEnd());
    if (m) remotes.push({ name: m[1]!, url: m[2]! });
  }
  return remotes;
}
