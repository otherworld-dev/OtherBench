/**
 * Compact diffs for file-edit tool calls (spec 2026-10-20-code-tab-design, Goal 5):
 * what the model asked to change, built from the call's own arguments, so it
 * works for every engine and needs no file read. Pure; the view is `EditDiff`.
 */

export interface DiffLine {
  /** `gap` stands for skipped unchanged lines between two hunks (its text is empty). */
  kind: 'add' | 'del' | 'ctx' | 'gap';
  text: string;
}

export interface EditDiffInfo {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
  isNewFile: boolean;
  /** Lines cut off past `MAX_LINES`, when any. */
  truncated?: number;
}

/** A diff longer than this is cut, so one huge write can't fill the thread. */
const MAX_LINES = 400;
/** Unchanged lines kept either side of a change. */
const CONTEXT = 3;

/**
 * An LCS table over this many cells is too big to be worth it; such a pair is shown as a plain replace.
 * Low on purpose: the view cuts at `MAX_LINES` anyway, and this runs while a reply streams.
 */
const MAX_CELLS = 250_000;

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** Line diff by longest common subsequence, context trimmed to 3 lines around each change; empty when equal. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid: DiffLine[] = [];
  if (midA.length * midB.length > MAX_CELLS) {
    for (const t of midA) mid.push({ kind: 'del', text: t });
    for (const t of midB) mid.push({ kind: 'add', text: t });
  } else {
    const n = midA.length;
    const m = midB.length;
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        mid.push({ kind: 'ctx', text: midA[i]! });
        i++;
        j++;
      } else if (j < m && (i === n || table[i]![j + 1]! >= table[i + 1]![j]!)) {
        // Reordered to del-then-add by `delsFirst` below.
        mid.push({ kind: 'add', text: midB[j]! });
        j++;
      } else {
        mid.push({ kind: 'del', text: midA[i]! });
        i++;
      }
    }
  }
  if (!mid.some((l) => l.kind !== 'ctx')) return [];
  const out: DiffLine[] = [
    ...a.slice(Math.max(0, start - CONTEXT), start).map((text) => ({ kind: 'ctx' as const, text })),
    ...mid,
    ...a.slice(endA, endA + CONTEXT).map((text) => ({ kind: 'ctx' as const, text })),
  ];
  // Context inside the changed middle is trimmed too, so two far-apart edits don't drag the lines between them along.
  const keep = out.map((l, idx) => l.kind !== 'ctx' || out.slice(Math.max(0, idx - CONTEXT), idx + CONTEXT + 1).some((o) => o.kind !== 'ctx'));
  // A "…" gap row where unchanged lines between two hunks were dropped (never at either end).
  const kept: DiffLine[] = [];
  let skipped = false;
  out.forEach((l, idx) => {
    if (!keep[idx]) {
      skipped = kept.length > 0;
      return;
    }
    if (skipped) kept.push({ kind: 'gap', text: '' });
    skipped = false;
    kept.push(l);
  });
  return delsFirst(kept);
}

/** Orders a run so a block of deletions comes before its additions. */
function delsFirst(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let adds: DiffLine[] = [];
  let dels: DiffLine[] = [];
  const settle = (): void => {
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === 'add') adds.push(l);
    else if (l.kind === 'del') dels.push(l);
    else {
      settle();
      out.push(l);
    }
  }
  settle();
  return out;
}

/** The tool name without an MCP prefix (`mcp__server__Edit` -> `Edit`). */
function bareName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return m?.[1] ?? name;
}

function str(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
  return null;
}

function build(path: string, lines: DiffLine[], isNewFile: boolean): EditDiffInfo {
  const added = lines.filter((l) => l.kind === 'add').length;
  const removed = lines.filter((l) => l.kind === 'del').length;
  const info: EditDiffInfo = { path, lines, added, removed, isNewFile };
  if (lines.length > MAX_LINES) {
    info.lines = lines.slice(0, MAX_LINES);
    info.truncated = lines.length - MAX_LINES;
  }
  return info;
}

/**
 * The diff a call to a file-edit tool asks for; null when it isn't one or its
 * arguments are malformed. Claude Code's `Edit`, `MultiEdit` and `Write` (bare
 * names, `file_path`) and OtherBench's own `edit_file` / `write_file` (`path`,
 * `oldString`/`newString`).
 */
export function editDiffOf(toolName: string, args: unknown): EditDiffInfo | null {
  // A reply re-renders on every streamed token, and the args object of a stored call is stable, so each is diffed once.
  if (typeof args === 'object' && args !== null) {
    const hit = memo.get(args);
    if (hit && hit.name === toolName) return hit.info;
    const info = computeEditDiff(toolName, args);
    memo.set(args, { name: toolName, info });
    return info;
  }
  return null;
}

const memo = new WeakMap<object, { name: string; info: EditDiffInfo | null }>();

function computeEditDiff(toolName: string, args: unknown): EditDiffInfo | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const o = args as Record<string, unknown>;
  const path = str(o, 'file_path', 'path');
  if (path === null || path.trim() === '') return null;
  switch (bareName(toolName)) {
    case 'Edit':
    case 'edit_file': {
      const before = str(o, 'old_string', 'oldString');
      const after = str(o, 'new_string', 'newString');
      return before === null || after === null ? null : build(path, lineDiff(before, after), false);
    }
    case 'MultiEdit': {
      if (!Array.isArray(o['edits'])) return null;
      const lines: DiffLine[] = [];
      for (const e of o['edits'] as unknown[]) {
        if (typeof e !== 'object' || e === null) return null;
        const r = e as Record<string, unknown>;
        if (typeof r['old_string'] !== 'string' || typeof r['new_string'] !== 'string') return null;
        const part = lineDiff(r['old_string'], r['new_string']);
        // Edits are separate hunks, so a gap row sits between them.
        if (lines.length > 0 && part.length > 0) lines.push({ kind: 'gap', text: '' });
        lines.push(...part);
      }
      return build(path, lines, false);
    }
    case 'Write':
    case 'write_file': {
      const content = str(o, 'content');
      return content === null ? null : build(path, splitLines(content).map((text) => ({ kind: 'add' as const, text })), true);
    }
    default:
      return null;
  }
}

/**
 * The line the server's git diff ends with when it cut the diff short
 * (`DIFF_TRUNCATED_MARKER` in packages/server/src/code/git.ts; the web can't
 * import from the server, so it is repeated here). A diff line always starts
 * with one of ` +-@\` or a header word, so a line equal to this is never content.
 */
export const DIFF_TRUNCATED_MARKER = '... diff truncated';

/** Whether a `git diff` from the server was cut short (spec 2026-10-20-code-tab-design, Goal 2: the git panel says so rather than showing a silently partial diff). */
export function diffTruncated(text: string): boolean {
  return text.split('\n').some((l) => l === DIFF_TRUNCATED_MARKER);
}

const BACKSLASH = '\\';

/** A path from a `---`/`+++` line: git's C-style quoting undone, the `a/`/`b/` prefix and a trailing tab (git adds one to names with spaces) dropped. */
function diffPath(raw: string): string | null {
  let p = raw.replace(/\t$/, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) {
    const ESC: Record<string, string> = { n: '\n', t: '\t', '"': '"', [BACKSLASH]: BACKSLASH, a: '\x07', b: '\b', f: '\f', r: '\r', v: '\v' };
    const utf8 = new TextEncoder();
    const bytes: number[] = [];
    const body = p.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch !== BACKSLASH) {
        bytes.push(...utf8.encode(ch));
        continue;
      }
      const next = body[i + 1] ?? '';
      const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
      if (oct) {
        bytes.push(parseInt(oct[0], 8));
        i += 3;
      } else {
        bytes.push(...utf8.encode(ESC[next] ?? next));
        i += 1;
      }
    }
    p = new TextDecoder().decode(new Uint8Array(bytes));
  }
  return p.replace(/^[ab]\//, '');
}

/**
 * A unified `git diff` (as the git panel's diff route sends it) split per
 * file into the same `DiffLine`s an edit diff uses, so `EditDiff` shows both
 * (spec 2026-10-20-code-tab-design, Goal 2: the git panel shows the real git
 * diff). Hunk headers become `gap` rows between hunks; file headers, mode
 * lines and "\ No newline" notes are dropped; the server's truncation marker
 * is dropped too (ask `diffTruncated`). A file is named by its `+++` path, or
 * its `---` path when it was deleted, or the `diff --git` line when neither is
 * there (a binary or mode-only change, which then has no lines).
 */
export function parseUnifiedDiff(text: string): { path: string; lines: DiffLine[] }[] {
  const out: { path: string; lines: DiffLine[] }[] = [];
  let cur: { path: string; lines: DiffLine[]; oldPath: string | null; inHunk: boolean } | null = null;
  const settle = (): void => {
    if (cur) out.push({ path: cur.path, lines: cur.lines });
    cur = null;
  };
  for (const line of text.split('\n')) {
    if (line === DIFF_TRUNCATED_MARKER) break;
    if (line.startsWith('diff --git ')) {
      settle();
      // `a/x b/x`: with equal names the second half is the name; a quoted or spaced pair is fixed up by the ---/+++ lines.
      const m = /^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/.exec(line);
      cur = { path: m?.[2] ?? line.slice('diff --git '.length), lines: [], oldPath: null, inHunk: false };
      continue;
    }
    if (!cur) continue;
    const c: { path: string; lines: DiffLine[]; oldPath: string | null; inHunk: boolean } = cur;
    if (line.startsWith('@@')) {
      if (c.lines.length > 0) c.lines.push({ kind: 'gap', text: '' });
      c.inHunk = true;
      continue;
    }
    if (!c.inHunk) {
      if (line.startsWith('--- ')) c.oldPath = diffPath(line.slice(4));
      else if (line.startsWith('+++ ')) c.path = diffPath(line.slice(4)) ?? c.oldPath ?? c.path;
      continue;
    }
    if (line.startsWith('+')) c.lines.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) c.lines.push({ kind: 'del', text: line.slice(1) });
    else if (line.startsWith(' ')) c.lines.push({ kind: 'ctx', text: line.slice(1) });
    // "\ No newline at end of file", and the empty last line, are not content.
  }
  settle();
  return out;
}
