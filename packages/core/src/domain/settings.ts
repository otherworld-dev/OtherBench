import type { AppSettings } from '../ports/store.js';

/**
 * What `SettingsRepo.get()` returns for a key that was never set. `peerComputerControl` is off until the person at
 * this machine turns it on in its desktop app. Defaults are never written out (`update` stores only what it is
 * given), so a database that never set it reads it as off.
 */
export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = { memoryProfileId: null, githubEnabled: true, nextcloudEnabled: true, peerComputerControl: false, handoverEnabled: true, handoverThresholdTokens: 300_000 };

/** What a request that may not turn on "Let paired machines start and approve computer use" is told. */
export const PEER_COMPUTER_CONTROL_HOST_ONLY_REASON =
  '"Let paired machines start and approve computer use" can only be turned on in the OtherBench desktop app on this computer. It can be turned off from anywhere.';

/** What a switch-on is told when this server has no desktop app to ask the person here (headless, or the app isn't running it). */
export const PEER_COMPUTER_CONTROL_NO_DESKTOP_REASON =
  '"Let paired machines start and approve computer use" can only be turned on in the OtherBench desktop app on this computer, which asks you to confirm it there. This OtherBench has no desktop app to ask.';

/** What a switch-on is told while computer use may be in control here: nobody is asked while a model could be at the screen. */
export const PEER_COMPUTER_CONTROL_IN_CONTROL_REASON =
  'OtherBench is controlling this computer (or may be), so it won\'t ask about letting paired machines in now. Stop computer use first.';

/** What a second switch-on is told while the first one's question is still up. */
export const PEER_COMPUTER_CONTROL_ASKING_REASON = 'OtherBench is already asking about this on this computer. Answer that first.';

/** What a switch-on the person here didn't confirm is told; `why` is the desktop app's reason. */
export function peerComputerControlNotConfirmedReason(why: string): string {
  return `It wasn't turned on: it needs an OK in the question OtherBench shows on this computer. ${why}`.trim();
}

/** The question the desktop app shows on this computer before the setting is turned on. Plain text; Cancel is the default. */
export const PEER_COMPUTER_CONTROL_CONFIRM_TEXT = [
  'Let paired machines start and approve computer use on this computer?',
  "With this on, another of your machines paired with this one can ask to start computer use here (someone here still has to accept each start). While a session runs it can send messages and answer the session's approval cards, so it can control this computer's mouse and keyboard in the apps those cards let through, with nobody here approving each step.",
  'Only press OK if you just turned this on yourself, in OtherBench on this computer. You can turn it off any time in Settings, Machines.',
].join('\n\n');

/**
 * Whether a change of `peerComputerControl` from `current` to `wanted` needs the person at this machine to confirm it
 * in the desktop app's native dialog (`HostConfirm`) before it is written. Turning it on does, whoever asks: the
 * request's `Origin` is only an early refusal for a browser tab or a phone (`mayChangePeerComputerControl`), never
 * the boundary, since any program can send any header. Turning it off, or leaving it as it is, never does.
 */
export function peerComputerControlNeedsHostConfirm(current: boolean, wanted: boolean): boolean {
  return wanted && !current;
}

/**
 * The early refusal before anyone is asked: a switch-on whose request doesn't even claim to come from the desktop
 * app's window (`fromTheDesktopApp`: its `Origin` is one of the shell's) is refused at once, so a browser tab or a
 * signed-in phone gets a clear answer and no dialog pops up on this computer for it. Not a security boundary: a
 * program can forge the header, and then the native confirmation is what stops it. Turning it off, or leaving it as
 * it is, is allowed from anywhere that can reach Settings.
 */
export function mayChangePeerComputerControl(current: boolean, wanted: boolean, fromTheDesktopApp: boolean): boolean {
  return !peerComputerControlNeedsHostConfirm(current, wanted) || fromTheDesktopApp;
}
