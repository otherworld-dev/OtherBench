import { readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { ADDON_API_VERSION, type AddonManifest } from '@otherbench/addon-api';
import { containPath } from '@otherbench/core/domain/paths.js';

/** An add-on's id, and its folder's name: lower case letters, digits and dashes, 2 to 32 long, starting with a letter. */
export const ADDON_ID = /^[a-z][a-z0-9-]{1,31}$/;

export type ManifestRead =
  | { ok: true; manifest: AddonManifest; mainPath: string; pagePath: string | null }
  | { ok: false; error: string };

/** A path the manifest names, resolved inside the add-on's folder (links followed), or null when it leads out. */
function inside(folder: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.trim() === '' || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  try {
    return containPath(folder, rel);
  } catch {
    return null;
  }
}

/** Reads and checks `<folder>/addon.json`. Never throws: a bad manifest is a reason the add-on didn't load. */
export function readManifest(folder: string): ManifestRead {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(`${folder}/addon.json`, 'utf8'));
  } catch (err) {
    return { ok: false, error: `Its addon.json couldn't be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'Its addon.json is not an object.' };
  const m = raw as Record<string, unknown>;
  const folderName = basename(folder);
  if (typeof m['id'] !== 'string' || !ADDON_ID.test(m['id'])) return { ok: false, error: 'Its id must be lower case letters, digits and dashes, starting with a letter.' };
  if (m['id'] !== folderName) return { ok: false, error: `Its id "${m['id']}" is not its folder's name "${folderName}".` };
  if (typeof m['name'] !== 'string' || m['name'].trim() === '') return { ok: false, error: 'It has no name.' };
  if (typeof m['version'] !== 'string' || m['version'].trim() === '') return { ok: false, error: 'It has no version.' };
  if (m['apiVersion'] !== ADDON_API_VERSION) {
    return { ok: false, error: `It was built for add-on API version ${String(m['apiVersion'])}, and this OtherBench offers version ${ADDON_API_VERSION}. Rebuild it against this OtherBench.` };
  }
  const mainPath = inside(folder, m['main']);
  if (mainPath === null) return { ok: false, error: 'Its main must be a file inside its own folder.' };
  let pagePath: string | null = null;
  if (m['settingsPage'] !== undefined) {
    pagePath = inside(folder, m['settingsPage']);
    if (pagePath === null) return { ok: false, error: 'Its settings page must be a folder inside its own folder.' };
  }
  if (m['branchPrefix'] !== undefined && (typeof m['branchPrefix'] !== 'string' || !ADDON_ID.test(m['branchPrefix']))) {
    return { ok: false, error: 'Its branchPrefix must be lower case letters, digits and dashes, starting with a letter.' };
  }
  const manifest: AddonManifest = {
    id: m['id'],
    name: m['name'].trim(),
    version: m['version'].trim(),
    apiVersion: ADDON_API_VERSION,
    main: m['main'] as string,
    ...(typeof m['settingsPage'] === 'string' ? { settingsPage: m['settingsPage'] } : {}),
    ...(typeof m['branchPrefix'] === 'string' ? { branchPrefix: m['branchPrefix'] } : {}),
  };
  return { ok: true, manifest, mainPath, pagePath };
}
