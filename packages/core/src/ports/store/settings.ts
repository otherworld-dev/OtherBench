// --- app settings ----------------------------------------------------------------

/** App-wide settings (one set per database). Defaults: `DEFAULT_APP_SETTINGS`. */
export interface AppSettings {
  /** The profile both memory summarisers run on; null = the project's default profile (project notes), then the app default. */
  memoryProfileId: string | null;
  /** False turns GitHub off on this machine: no Issues, no inbox, and the server never runs `gh` (Settings, Features). */
  githubEnabled: boolean;
  /** False turns Nextcloud off on this machine: no Deck, Wiki or Links, and the server never calls Nextcloud. */
  nextcloudEnabled: boolean;
  /**
   * "Let paired machines start and approve computer use" (Settings, Machines), off by default. On: a paired machine
   * may ask to start a computer-use session here (this machine's own start dialog asks, naming that machine), send
   * messages and answer cards while one is in control. Off: it can still see a session here and Stop it, nothing
   * more. Only switched on with an OK in this machine's desktop app's native dialog (`HostConfirm`); off from anywhere that
   * reaches Settings. It never switches computer use itself on. Machine-local and never synced, like every setting.
   */
  peerComputerControl: boolean;
  /** Offer a fresh chat when a Claude Code chat's calls read more than `handoverThresholdTokens` (spec 2026-11-06-fresh-chat-handover-design). */
  handoverEnabled: boolean;
  /** The context size per call, in tokens, from which the fresh chat card shows. */
  handoverThresholdTokens: number;
  /**
   * What a Deck card's "Start a chat on this" sends at once, e.g. `/start {card}` (`{card}` becomes `d123`; without it
   * the ref goes on the end). Empty, the default, leaves the card in the new chat's box unsent (`fillStartCommand`).
   */
  deckStartCommand: string;
  /** The same for a GitHub issue's, with `{issue}` becoming `#45`. */
  issueStartCommand: string;
}

export interface SettingsRepo {
  get(): AppSettings;
  /** Applies the keys `patch` defines and returns the full settings. */
  update(patch: Partial<AppSettings>): AppSettings;
  /**
   * A machine-local value kept beside the settings (the same `app_setting`
   * table, never synced and never in `get()`), e.g. the sandbox's state
   * (key `sandbox`). Null when unset or unreadable.
   */
  getValue(key: string): unknown;
  /** Stores `value` as JSON under `key`; null removes it. Throws for an AppSettings key, which `update()` owns. */
  setValue(key: string, value: unknown): void;
}
