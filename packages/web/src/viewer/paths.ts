/**
 * Bare file names worth offering to open: a known extension, no folder. No
 * one-letter extensions (`.c`, `.h`): bare, `a.b.c` is far likelier code
 * than a file; with a folder (`src/main.c`) it still counts.
 */
const BARE_FILE = /^[\w@.-]+\.(?:md|markdown|txt|html?|json|ya?ml|toml|csv|tsx?|jsx?|mjs|cjs|py|rs|go|java|cs|cpp|css|scss|sh|ps1|sql|xml|svg|png|jpe?g|gif|webp|bmp|avif|pdf|mp4|webm|ogv)$/i;

/** Whether inline code looks like a file path worth a click (the server decides whether it opens). */
export function looksLikePath(text: string): boolean {
  if (text.length === 0 || text.length > 400 || /[\n<>"|?*]/.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{1,2}[\\/])/.test(text)) return true;
  if (/\s/.test(text)) return false;
  return /[\\/]/.test(text) ? /[\\/][^\\/]+$/.test(text) && !/[()]/.test(text) : BARE_FILE.test(text);
}

/** Tools whose path argument is a folder, not a file to view. */
const FOLDER_TOOLS = new Set(['list_dir', 'search_files', 'LS', 'Glob', 'Grep']);

/** The file a tool call read or wrote, to offer opening it in the viewer; null for folder tools or no path. */
export function toolPath(name: string, args: unknown): string | null {
  if (FOLDER_TOOLS.has(name) || typeof args !== 'object' || args === null) return null;
  for (const key of ['path', 'file_path', 'notebook_path']) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/** Whether a tool call is the artifact tool (Deck #896): both engines report Grunt's under this name. */
export function isArtifactTool(name: string): boolean {
  return name === 'artifact';
}

export interface ArtifactCardInfo {
  command: 'create' | 'update' | 'rewrite';
  artifactId: string;
  slug: string;
  title: string;
  kind: string;
  number: number;
  versionId: string;
}

/** What an artifact call made, from its result: a JSON string (API engines), an MCP content list (Claude Code) or an object; null for errors and `view`. */
export function artifactOutcomeOf(result: unknown): ArtifactCardInfo | null {
  let value: unknown = result;
  if (Array.isArray(value)) value = (value.find((b) => (b as { type?: unknown } | null)?.type === 'text') as { text?: unknown } | undefined)?.text;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o['ok'] !== true) return null;
  if (o['command'] !== 'create' && o['command'] !== 'update' && o['command'] !== 'rewrite') return null;
  for (const key of ['artifactId', 'slug', 'title', 'kind', 'versionId']) if (typeof o[key] !== 'string') return null;
  if (typeof o['number'] !== 'number') return null;
  return o as unknown as ArtifactCardInfo;
}

/** The folder `path` is in: everything before its last separator. */
export function dirOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '');
}

/** Whether `href` is a path relative to a file (not a URL, an absolute path or an in-page anchor). */
export function isRelativePath(href: string): boolean {
  return href !== '' && !href.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[\\/]/.test(href);
}

/** `rel` from the folder `base`, `.` and `..` resolved, with `base`'s own separator; never above `base`'s root. */
export function joinPath(base: string, rel: string): string {
  const sep = base.includes('\\') ? '\\' : '/';
  const parts = base.split(/[\\/]/);
  const rootLength = parts[0] === '' || /^[A-Za-z]:$/.test(parts[0] ?? '') ? 1 : 0;
  for (const segment of rel.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > rootLength) parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join(sep);
}
