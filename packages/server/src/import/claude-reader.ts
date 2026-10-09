import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { ClaudeExportError, type ClaudeExportFiles } from '@grunt/core/domain/claude-import.js';
import { containPath, PathEscapeError } from '@grunt/core/domain/paths.js';
import { listZipEntries, readZipEntry, ZipError } from './zip.js';

/**
 * Reads a claude.ai export from a folder (spec 2026-10-09-claude-import-design
 * §1): the ZIPs as downloaded from the export email, what's in them once
 * extracted, or a mix. Only the parts the import uses are read, by name:
 * `conversations.json`, `projects/*.json`, `memories/*.json` and
 * `artifacts/<id>/artifact.json` with its `versions/*.html`. ZIPs are read in
 * memory; nothing is written. Links are skipped and every path is checked
 * with `containPath`, so nothing outside the folder is read.
 */

/** The largest single file read, extracted or in a ZIP. */
export const MAX_EXPORT_FILE_BYTES = 512 * 1024 * 1024;
/** The largest ZIP read whole into memory. */
export const MAX_EXPORT_ZIP_BYTES = 2 * 1024 * 1024 * 1024;
/** How deep the folder is searched, and how many files at most. */
const MAX_DEPTH = 6;
const MAX_FILES = 20_000;

export interface ClaudeExportRead {
  files: ClaudeExportFiles;
  /** Where each part was found, relative to the folder: for the preview. */
  sources: string[];
}

type Part = { kind: 'conversations' } | { kind: 'project' } | { kind: 'memory' } | { kind: 'artifact-meta'; artifact: string } | { kind: 'artifact-html'; artifact: string; version: string };

/** What an entry is, from its path inside the export (any leading folders ignored), or null for what the import doesn't use. */
export function classifyExportPath(path: string): Part | null {
  const p = path.replace(/\\/g, '/');
  if (basename(p) === 'conversations.json') return { kind: 'conversations' };
  if (/(^|\/)projects\/[^/]+\.json$/.test(p)) return { kind: 'project' };
  if (/(^|\/)memories\/[^/]+\.json$/.test(p)) return { kind: 'memory' };
  const meta = /(^|\/)artifacts\/([^/]+)\/artifact\.json$/.exec(p);
  if (meta) return { kind: 'artifact-meta', artifact: meta[2]! };
  const html = /(^|\/)artifacts\/([^/]+)\/versions\/([^/]+)\.html$/.exec(p);
  if (html) return { kind: 'artifact-html', artifact: html[2]!, version: html[3]! };
  return null;
}

class Collector {
  readonly conversations: unknown[] = [];
  readonly projects: unknown[] = [];
  readonly memories: unknown[] = [];
  readonly artifactMeta = new Map<string, unknown>();
  readonly artifactHtml = new Map<string, Record<string, string>>();
  readonly sources: string[] = [];

  add(part: Part, source: string, content: Buffer): void {
    if (part.kind === 'artifact-html') {
      const html = this.artifactHtml.get(part.artifact) ?? {};
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
    } else {
      this.artifactMeta.set(part.artifact, value);
    }
  }

  result(): ClaudeExportRead {
    const artifacts = [...this.artifactMeta].map(([id, meta]) => ({ meta, html: this.artifactHtml.get(id) ?? {} }));
    return { files: { conversations: this.conversations, projects: this.projects, memories: this.memories, artifacts }, sources: this.sources };
  }
}

/** Every regular file under `root` (no links), as paths relative to it with `/` separators. */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile()) {
        if (found.length >= MAX_FILES) throw new ClaudeExportError(`The folder has more than ${MAX_FILES.toLocaleString('en-US')} files in it. Choose the folder that holds just the export.`);
        found.push(child);
      } else if (e.isDirectory() && depth < MAX_DEPTH) {
        await walk(child, depth + 1);
      }
    }
  };
  await walk('', 0);
  return found.sort();
}

/** Reads the export in `folder`. Throws `ClaudeExportError` with a message for the user when it can't. */
export async function readClaudeExport(folder: string): Promise<ClaudeExportRead> {
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
      await readZip(path, rel, collector);
      continue;
    }
    const part = classifyExportPath(rel);
    if (!part) continue;
    const size = (await stat(path)).size;
    if (size > MAX_EXPORT_FILE_BYTES) throw new ClaudeExportError(`${rel} is too big to import (${size.toLocaleString('en-US')} bytes).`);
    collector.add(part, rel, await readFile(path));
  }

  const read = collector.result();
  if (read.sources.every((s) => !s.endsWith('conversations.json'))) {
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
      if (!part) continue;
      collector.add(part, `${rel}: ${entry.name}`, readZipEntry(zip, entry, MAX_EXPORT_FILE_BYTES));
    }
  } catch (err) {
    if (err instanceof ZipError) throw new ClaudeExportError(`${rel}: ${err.message}`);
    throw err;
  }
}
