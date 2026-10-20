/**
 * Compact diffs for file-edit tool calls (spec 2026-10-20-code-tab-design, Goal 5):
 * what the model asked to change, built from the call's own arguments, so it
 * works for every engine and needs no file read. Pure; the view is `EditDiff`.
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
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

/** An LCS table over this many cells is too big to be worth it; such a pair is shown as a plain replace. */
const MAX_CELLS = 4_000_000;

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
  return delsFirst(out.filter((_, idx) => keep[idx]));
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
        lines.push(...lineDiff(r['old_string'], r['new_string']));
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
