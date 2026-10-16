import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { ClaudeExportError, type ClaudeExportFiles } from '@otherbench/core/domain/claude-import.js';
import { containPath, PathEscapeError } from '@otherbench/core/domain/paths.js';
import { listZipEntries, readZipEntry, ZipError } from './zip.js';

/**
 * Reads a claude.ai export from a folder (spec 2026-10-09-claude-import-design
 * §1): the ZIPs as downloaded from the export email, what's in them once
 * extracted, or a mix. Only the parts the import uses are read, by name:
 * `conversations.json`, `projects/*.json`, `memories/*.json` and
 * `artifacts/<id>/artifact.json` with its `versions/*.html`, from files or
 * from the export's own ZIPs (`conversations-000.zip` and the like; any other
 * ZIP is left alone). ZIPs are read in memory; nothing is written. Every path
 * is checked with `containPath`, so a link leading outside the folder is
 * never followed, and what is read is capped in size and number.
 *
 * The export has no images or files, only their names. A `files/index.json`
 * in the folder (not in a ZIP) lists ones saved from claude.ai next to it,
 * each named by its claude.ai file id; only the list is read here, and the
 * import reads each file when it stores it (`filesDir`).
 */

/** The largest single file read, extracted or in a ZIP. */
export const MAX_EXPORT_FILE_BYTES = 512 * 1024 * 1024;
/** The largest ZIP read whole into memory: under Node's 2 GiB limit for one read. */
export const MAX_EXPORT_ZIP_BYTES = 2 * 1024 * 1024 * 1024 - 1;
/** The most the export's parts may add up to once read and decompressed, and how many of them there may be. */
export const MAX_EXPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PARTS = 50_000;
/** How deep the folder is searched, and how many files at most. */
const MAX_DEPTH = 6;
const MAX_FILES = 20_000;
/** The ZIPs a claude.ai export arrives as, e.g. `conversations-000.zip` (a browser may add " (1)"); other ZIPs in the folder are left alone. */
const EXPORT_ZIP = /^(conversations|projects|memories|frames)-\d+( \(\d+\))?\.zip$/i;

export interface ClaudeExportRead {
  files: ClaudeExportFiles;
  /** Where each part was found, relative to the folder: for the preview. */
  sources: string[];
  /** The claude.ai organisation the export is from, read off its manifest's download links, or null. */
  organizationId: string | null;
  /** Whether the folder held a claude.ai export (its conversations) at all. */
  hasExport: boolean;
  /** The folder holding the files saved from claude.ai (where `files/index.json` was), or null when there is none. */
  filesDir?: string | null;
}

type Part =
  | { kind: 'conversations' }
  | { kind: 'conversation-list' }
  | { kind: 'manifest' }
  | { kind: 'project' }
  | { kind: 'memory' }
  | { kind: 'artifact-meta'; artifact: string }
  | { kind: 'artifact-html'; artifact: string; version: string }
  | { kind: 'file-index' };

/** What an entry is, from its path inside the export (any leading folders ignored), or null for what the import doesn't use. */
export function classifyExportPath(path: string): Part | null {
  const p = path.replace(/\\/g, '/');
  const name = basename(p);
  if (name === 'conversations.json') return { kind: 'conversations' };
  // claude.ai's chat list, saved by the user from its own API (chatListUrl); a browser may add " (1)".
  if (/^chat_conversations[^/]*\.json$/i.test(name)) return { kind: 'conversation-list' };
  // The export email's manifest, which names the organisation in its download links.
  if (/^manifest-[^/]*\.json$/i.test(name)) return { kind: 'manifest' };
  if (/(^|\/)projects\/[^/]+\.json$/.test(p)) return { kind: 'project' };
  if (/(^|\/)memories\/[^/]+\.json$/.test(p)) return { kind: 'memory' };
  const meta = /(^|\/)artifacts\/([^/]+)\/artifact\.json$/.exec(p);
  if (meta) return { kind: 'artifact-meta', artifact: meta[2]! };
  const html = /(^|\/)artifacts\/([^/]+)\/versions\/([^/]+)\.html$/.exec(p);
  if (html) return { kind: 'artifact-html', artifact: html[2]!, version: html[3]! };
  if (/(^|\/)files\/index\.json$/.test(p)) return { kind: 'file-index' };
  return null;
}

class Collector {
  readonly conversations: unknown[] = [];
  readonly projects: unknown[] = [];
  readonly memories: unknown[] = [];
  readonly conversationList: unknown[] = [];
  organizationId: string | null = null;
  readonly artifactMeta = new Map<string, unknown>();
  readonly artifactHtml = new Map<string, Record<string, string>>();
  readonly sources: string[] = [];
  /** `files/index.json`, and its folder relative to the export's: only one is used. */
  downloaded: unknown = undefined;
  filesRel: string | null = null;
  private bytes = 0;
  private parts = 0;

  /** Counts a part about to be read, refusing an export that adds up to more than the import holds in memory. */
  admit(size: number): void {
    this.bytes += size;
    this.parts += 1;
    if (this.bytes > MAX_EXPORT_TOTAL_BYTES) throw new ClaudeExportError('The export is too big to import: its parts add up to more than 2 GiB.');
    if (this.parts > MAX_PARTS) throw new ClaudeExportError(`The export has more than ${MAX_PARTS.toLocaleString('en-US')} parts, which is more than the import reads.`);
  }

  add(part: Part, source: string, content: Buffer): void {
    if (part.kind === 'artifact-html') {
      // No prototype: a version id such as "constructor" is just a key.
      const html = this.artifactHtml.get(part.artifact) ?? (Object.create(null) as Record<string, string>);
      html[part.version] = content.toString('utf8');
      this.artifactHtml.set(part.artifact, html);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(content.toString('utf8'));
    } catch {
      throw new ClaudeExportError(`${source} isn't valid JSON, so the export can't be read. Download it again.`);
    }
    if (part.kind === 'conversations') {
      if (!Array.isArray(value)) throw new ClaudeExportError(`${source} isn't a list of conversations, so this doesn't look like a claude.ai export.`);
      this.conversations.push(...(value as unknown[]));
      this.sources.push(source);
    } else if (part.kind === 'project') {
      this.projects.push(value);
    } else if (part.kind === 'memory') {
      this.memories.push(value);
      this.sources.push(source);
    } else if (part.kind === 'conversation-list') {
      this.conversationList.push(value);
      this.sources.push(source);
    } else if (part.kind === 'file-index') {
      if (this.filesRel !== null) return;
      this.downloaded = value;
      this.filesRel = dirname(source.replace(/\\/g, '/'));
      this.sources.push(source);
    } else if (part.kind === 'manifest') {
      const link = JSON.stringify(value).match(/\/export\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/download\//i);
      this.organizationId ??= link?.[1] ?? null;
    } else {
      this.artifactMeta.set(part.artifact, value);
    }
  }

  result(): ClaudeExportRead {
    const artifacts = [...this.artifactMeta].map(([id, meta]) => ({ meta, html: this.artifactHtml.get(id) ?? {} }));
    return {
      files: { conversations: this.conversations, projects: this.projects, memories: this.memories, artifacts, conversationList: this.conversationList, ...(this.downloaded !== undefined ? { downloaded: this.downloaded } : {}) },
      sources: this.sources,
      organizationId: this.organizationId,
      hasExport: this.sources.some((s) => s.endsWith('conversations.json')),
    };
  }
}

/** What `rel` under `root` is once links are followed, or null when it leads outside `root` or can't be read. */
async function kindOf(root: string, rel: string): Promise<'file' | 'dir' | null> {
  try {
    const info = await stat(containPath(root, rel));
    return info.isFile() ? 'file' : info.isDirectory() ? 'dir' : null;
  } catch {
    return null;
  }
}

/**
 * Every file under `root`, as paths relative to it with `/` separators.
 * Links (on Windows, any reparse point, which includes OneDrive's files) are
 * followed only when they lead somewhere inside `root`. A folder that can't
 * be read is passed over; only `root` itself must be readable. A Cowork
 * session's own folder (`local_<id>/`, in a copy of Cowork's folder) is never
 * searched: what a session wrote could be named like a part of the export.
 */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch (err) {
      if (rel) return;
      throw new ClaudeExportError(`The folder can't be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      const kind = e.isFile() ? 'file' : e.isDirectory() ? 'dir' : await kindOf(root, child);
      if (kind === 'file') {
        if (found.length >= MAX_FILES) throw new ClaudeExportError(`The folder has more than ${MAX_FILES.toLocaleString('en-US')} files in it. Choose the folder that holds just the export.`);
        found.push(child);
      } else if (kind === 'dir' && depth < MAX_DEPTH && !e.name.startsWith('local_')) {
        await walk(child, depth + 1);
      }
    }
  };
  await walk('', 0);
  return found.sort();
}

/**
 * Reads the export in `folder`. Throws `ClaudeExportError` with a message for
 * the user when it can't, or when the folder holds no export and `optional`
 * isn't set (the folder may hold only Cowork sessions).
 */
export async function readClaudeExport(folder: string, { optional = false }: { optional?: boolean } = {}): Promise<ClaudeExportRead> {
  if (!isAbsolute(folder)) throw new ClaudeExportError('Give the full path of the folder the export is in.');
  let info;
  try {
    info = await stat(folder);
  } catch {
    throw new ClaudeExportError(`There's no folder at ${folder}.`);
  }
  if (!info.isDirectory()) throw new ClaudeExportError(`${folder} is a file, not a folder. Choose the folder the export's files are in.`);

  const collector = new Collector();
  for (const rel of await listFiles(folder)) {
    let path: string;
    try {
      path = containPath(folder, rel);
    } catch (err) {
      if (err instanceof PathEscapeError) continue;
      throw err;
    }
    if (rel.toLowerCase().endsWith('.zip')) {
      if (EXPORT_ZIP.test(basename(rel))) await readZip(path, rel, collector);
      continue;
    }
    const part = classifyExportPath(rel);
    if (!part) continue;
    const size = (await stat(path)).size;
    if (size > MAX_EXPORT_FILE_BYTES) throw new ClaudeExportError(`${rel} is too big to import (${size.toLocaleString('en-US')} bytes).`);
    collector.admit(size);
    collector.add(part, rel, await readFile(path));
  }

  const read = collector.result();
  read.filesDir = collector.filesRel === null ? null : containPath(folder, collector.filesRel);
  if (!read.hasExport && !optional) {
    throw new ClaudeExportError(`There's no conversations.json in ${folder}. Put every file from the claude.ai export email in one folder (the ZIPs, or what's in them) and choose that.`);
  }
  return read;
}

async function readZip(path: string, rel: string, collector: Collector): Promise<void> {
  const size = (await stat(path)).size;
  if (size > MAX_EXPORT_ZIP_BYTES) throw new ClaudeExportError(`${rel} is too big to import (${size.toLocaleString('en-US')} bytes). Extract it and choose the folder instead.`);
  const zip = await readFile(path);
  try {
    for (const entry of listZipEntries(zip)) {
      const part = classifyExportPath(entry.name);
      // Saved files are read from the folder, never from a ZIP.
      if (!part || part.kind === 'file-index') continue;
      collector.admit(entry.size);
      collector.add(part, `${rel}: ${entry.name}`, readZipEntry(zip, entry, MAX_EXPORT_FILE_BYTES));
    }
  } catch (err) {
    if (err instanceof ZipError) throw new ClaudeExportError(`${rel}: ${err.message}`);
    throw err;
  }
}
