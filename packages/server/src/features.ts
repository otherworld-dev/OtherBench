import type { Store } from '@otherbench/core/ports/store.js';
import { CodeRouteError } from './code/route-errors.js';

/**
 * GitHub and Nextcloud can each be turned off on this machine (Settings,
 * Features). Off means nothing reaches them: `githubOf` and
 * `nextcloudOrThrow`, the only ways to gh and to Nextcloud, call these first,
 * and the Overview's check skips them. The apps keep their repo, board and
 * wiki, so turning one back on brings it all back.
 */
export function githubOnOrThrow(store: Store): void {
  if (!store.settings.get().githubEnabled) throw new CodeRouteError(409, 'github-off', 'GitHub is turned off on this machine. Turn it on in Settings → Features.');
}

export function nextcloudOnOrThrow(store: Store): void {
  if (!store.settings.get().nextcloudEnabled) throw new CodeRouteError(409, 'nextcloud-off', 'Nextcloud is turned off on this machine. Turn it on in Settings → Features.');
}
