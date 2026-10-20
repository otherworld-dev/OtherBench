import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import { editDiffOf, type EditDiffInfo } from './editDiff.js';

/** One file a chat changed: its edits in the order they ran, and their +/− counts summed. */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  edits: EditDiffInfo[];
}

/** Slashes one way, no trailing one and no leading `./`, so `E:\a\b`, `E:/a/b/` and `./x`/`x` compare equal. */
function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^(?:\.\/)+/, '');
}

/**
 * `path` relative to `root` when it is inside it, so Claude Code's absolute
 * `file_path` and OtherBench's own relative `path` name one file once. Compared
 * without regard to case only on a drive-letter (Windows) root, where the file
 * system ignores it too.
 */
function underRoot(path: string, root: string | null | undefined): string {
  const p = normalise(path);
  if (!root) return p;
  const r = normalise(root);
  const fold = /^[A-Za-z]:/.test(r);
  const pc = fold ? p.toLowerCase() : p;
  const rc = fold ? r.toLowerCase() : r;
  return pc.startsWith(`${rc}/`) ? p.slice(r.length + 1) : p;
}

/** Every successful edit or write in one list of parts, and in the transcripts of the sub-agents it holds. */
function collect(parts: Part[], into: EditDiffInfo[]): void {
  // A call is paired with its result inside the same list, as the thread pairs them (Message.tsx).
  const failed = new Map<string, boolean>();
  for (const p of parts) if (p.type === 'tool-result') failed.set(p.id, p.isError);
  for (const p of parts) {
    if (p.type === 'subagent') collect(p.parts, into);
    if (p.type !== 'tool-call' || failed.get(p.id) !== false) continue;
    const diff = editDiffOf(p.name, p.args);
    if (diff) into.push(diff);
  }
}

/**
 * What one chat changed on disk, by file (spec 2026-10-20-code-tab-design,
 * Goal 6 and "Calls I made"): built from the chat's own edit and write tool
 * calls, not from `git status`, because several chats share an app's folder.
 * `messages` is the chat's whole message tree, and every message in it
 * counts: every branch, compare variant and retry, plus the calls of Claude
 * Code sub-agents stored in its `subagent` parts. All of them ran on disk.
 * A call counts only once it has a result that isn't an error, so a failed
 * edit, or one still waiting on its result or its approval, doesn't. Shell
 * commands that change files can't be seen here, which the spec accepts.
 *
 * With `root` (the app's folder on this machine) a path inside it is shown,
 * and grouped, relative to it. On a drive-letter (Windows) root, paths that
 * differ only in case are one file, as they are on disk there, and the file
 * is shown as first written. A chat that ran on another machine may name
 * that machine's absolute paths, which aren't under this root; they are
 * listed as they are. Files are sorted by path; each file's edits keep the
 * order their messages were written in.
 */
export function changedFiles(messages: CanonMessage[], root?: string | null): ChangedFile[] {
  const byKey = new Map<string, ChangedFile>();
  const foldCase = !!root && /^[A-Za-z]:/.test(normalise(root));
  const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  for (const m of ordered) {
    const edits: EditDiffInfo[] = [];
    collect(m.parts, edits);
    for (const e of edits) {
      const path = underRoot(e.path, root);
      const key = foldCase ? path.toLowerCase() : path;
      const file = byKey.get(key) ?? { path, added: 0, removed: 0, edits: [] };
      file.added += e.added;
      file.removed += e.removed;
      file.edits.push(e);
      byKey.set(key, file);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
