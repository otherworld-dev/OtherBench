/**
 * A yes/no question put to the person at this machine in the desktop app's
 * own native dialog (a Windows message box the shell shows, with Cancel the
 * default), over the shell's private channel to this server, never an HTTP
 * route. Only the desktop server has one (`cli.ts`, with `--desktop-rpc`);
 * a headless or sign-in server has none.
 */
export interface HostConfirm {
  /**
   * Shows `text` and waits for the person. `ok: true` only when they pressed
   * OK; Cancel, closing it, nobody answering before it closes itself, the
   * desktop app being gone or too old to ask, or any fault all answer
   * `ok: false` with a reason. Nothing else can make it say yes.
   */
  confirm(text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}
