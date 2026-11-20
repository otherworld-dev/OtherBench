import { request } from './http.js';

/** What `GET /api/addons` says of each add-on installed on this machine (docs/features/addons.md). */
export interface AddonView {
  id: string;
  name: string;
  version: string | null;
  status: 'loaded' | 'failed';
  /** Why it didn't load. */
  error: string | null;
  /** Whether it has a settings page to show under Settings → Add-ons. */
  settingsPage: boolean;
}

export const addonsApi = {
  list: () => request<AddonView[]>('/addons'),
};
