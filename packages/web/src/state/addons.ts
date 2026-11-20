import { useEffect, useState } from 'react';
import { isDesktop, isMainAppWindow, showNotification } from '../desktop/bridge.js';
import { api } from './api.js';
import type { AddonView } from './api/addons.js';

/**
 * The add-ons installed on this machine (docs/features/addons.md), read once: they are only found when the server
 * starts. Empty while loading, on an error, and on every machine with none, which is what hides Settings → Add-ons.
 */
export function useAddons(): AddonView[] {
  const [addons, setAddons] = useState<AddonView[]>([]);
  useEffect(() => {
    let live = true;
    api.addons
      .list()
      .then((list) => {
        if (live) setAddons(list);
      })
      .catch((err: unknown) => console.warn('[otherbench-web] could not list add-ons:', err));
    return () => {
      live = false;
    };
  }, []);
  return addons;
}

/** Tells the user, once per start of the desktop app's main window, about each add-on that didn't load. */
export function useAddonLoadNotice(): void {
  useEffect(() => {
    if (!isDesktop() || !isMainAppWindow()) return;
    void api.addons
      .list()
      .then(async (list) => {
        for (const a of list) if (a.status === 'failed') await showNotification(`${a.name} didn't load`, `${a.error ?? 'No reason given.'} See Settings → Add-ons.`);
      })
      .catch(() => undefined);
  }, []);
}
