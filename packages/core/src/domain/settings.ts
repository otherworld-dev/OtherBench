import type { AppSettings } from '../ports/store.js';

/**
 * What `SettingsRepo.get()` returns for a key that was never set. `peerComputerControl` is off until the person at
 * this machine turns it on in its desktop app. Defaults are never written out (`update` stores only what it is
 * given), so a database that never set it reads it as off.
 */
export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = { memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true, peerComputerControl: false };

/** What a request that may not turn on "Let paired machines start and approve computer use" is told. */
export const PEER_COMPUTER_CONTROL_HOST_ONLY_REASON =
  '"Let paired machines start and approve computer use" can only be turned on in the OtherBench desktop app on this computer. It can be turned off from anywhere.';

/**
 * Whether a change of `peerComputerControl` from `current` to `wanted` may be made by this request. Turning it on is
 * this machine's own choice, so only its desktop app's window may make it (`fromTheDesktopApp`: the server's word,
 * from the request's `Origin`, never the caller's); not a browser tab, a signed-in phone, or a paired machine (the
 * peer listener has no settings route at all). Turning it off, or leaving it as it is, is allowed from anywhere that
 * can reach Settings.
 */
export function mayChangePeerComputerControl(current: boolean, wanted: boolean, fromTheDesktopApp: boolean): boolean {
  return !(wanted && !current) || fromTheDesktopApp;
}
