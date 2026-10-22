import type { NextcloudSettingsView } from '@otherbench/core/types/nextcloud.js';
import type { Container } from '../container.js';
import { CodeRouteError, codeCall } from '../code/route-errors.js';
import { httpNextcloudClient, type NextcloudClient } from './client.js';

/**
 * This machine's Nextcloud connection (spec 2026-10-22-nextcloud-tabs). The
 * URL and user are machine-local values in `app_setting` under
 * NEXTCLOUD_SETTING_KEY, never synced; the app password lives only in the
 * SecretStore under NEXTCLOUD_SECRET_REF and is never returned, logged or
 * put in an error message.
 */
export const NEXTCLOUD_SETTING_KEY = 'nextcloud';
export const NEXTCLOUD_SECRET_REF = 'nextcloud:password';

/** What `setValue(NEXTCLOUD_SETTING_KEY, ...)` holds. */
export interface StoredNextcloudSettings { baseUrl: string; user: string }

/** The stored URL and user, or null when unset or unreadable. */
export function storedNextcloudSettings(container: Container): StoredNextcloudSettings | null {
  const value = container.store.settings.getValue(NEXTCLOUD_SETTING_KEY);
  if (!value || typeof value !== 'object') return null;
  const { baseUrl, user } = value as Record<string, unknown>;
  if (typeof baseUrl !== 'string' || typeof user !== 'string' || !baseUrl || !user) return null;
  return { baseUrl, user };
}

export async function nextcloudSettings(container: Container): Promise<NextcloudSettingsView> {
  const stored = storedNextcloudSettings(container);
  const password = await container.secrets.get(NEXTCLOUD_SECRET_REF);
  return { baseUrl: stored?.baseUrl ?? null, user: stored?.user ?? null, passwordSet: Boolean(password) };
}

/** The client, or CodeRouteError(409, 'nextcloud-not-configured', "Nextcloud isn't set up on this machine. Add it in Settings → Nextcloud."). */
export async function nextcloudOrThrow(container: Container): Promise<NextcloudClient> {
  const stored = storedNextcloudSettings(container);
  const password = await container.secrets.get(NEXTCLOUD_SECRET_REF);
  if (!stored || !password) {
    throw new CodeRouteError(409, 'nextcloud-not-configured', "Nextcloud isn't set up on this machine. Add it in Settings → Nextcloud.");
  }
  const make = container.nextcloud ?? ((config) => httpNextcloudClient(config));
  // A stored URL that no longer passes normaliseBaseUrl is a NextcloudError, so a 409 rather than a 500.
  return codeCall(async () => make({ ...stored, password }));
}
