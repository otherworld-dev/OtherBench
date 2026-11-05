import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';

/**
 * Opens or closes an app (plan 2026-11-04-open-apps): whether it shows in the Code sidebar. Sends only `open`, and
 * keeps the app the server answers with rather than a copy from before, so a rename that synced in meanwhile isn't
 * lost (an Undo after a while, say). Rejects when the PATCH fails, leaving the app as it was; the caller says why.
 */
export async function setAppOpen(appId: string, open: boolean): Promise<void> {
  const app = await api.apps.patch(appId, { open });
  useOtherBenchStore.getState().upsertApp(app);
}
