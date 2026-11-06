import { create } from 'zustand';
import type { AppSettings } from '@otherbench/core/ports/store.js';
import { DEFAULT_HANDOVER_THRESHOLD } from '@otherbench/core/domain/handover.js';
import { api } from './api.js';

/**
 * GitHub and Nextcloud on or off on this machine (Settings, Features). Off hides every part of the UI that uses it.
 * Also the fresh chat card's switch and threshold (Settings, Claude accounts), which the card reads on every render.
 */
export interface Features {
  github: boolean;
  nextcloud: boolean;
  handoverEnabled: boolean;
  handoverThresholdTokens: number;
}

/** The last answer, so a window opens with the right tabs rather than flashing the ones that are off. */
const STORAGE_KEY = 'otherbench.features';
const ALL_ON: Features = { github: true, nextcloud: true, handoverEnabled: true, handoverThresholdTokens: DEFAULT_HANDOVER_THRESHOLD };

function loadFeatures(): Features {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Features> | null;
    return {
      github: raw?.github !== false,
      nextcloud: raw?.nextcloud !== false,
      handoverEnabled: raw?.handoverEnabled !== false,
      handoverThresholdTokens: typeof raw?.handoverThresholdTokens === 'number' ? raw.handoverThresholdTokens : DEFAULT_HANDOVER_THRESHOLD,
    };
  } catch {
    return ALL_ON;
  }
}

export const useFeatures = create<Features>(() => loadFeatures());

/** Takes the switches from settings the server sent. */
export function applyFeatures(settings: Pick<AppSettings, 'githubEnabled' | 'nextcloudEnabled'> & Partial<Pick<AppSettings, 'handoverEnabled' | 'handoverThresholdTokens'>>): void {
  const features: Features = {
    github: settings.githubEnabled !== false,
    nextcloud: settings.nextcloudEnabled !== false,
    handoverEnabled: settings.handoverEnabled !== false,
    handoverThresholdTokens: typeof settings.handoverThresholdTokens === 'number' ? settings.handoverThresholdTokens : DEFAULT_HANDOVER_THRESHOLD,
  };
  useFeatures.setState(features);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(features));
  } catch {
    // Storage full or blocked: the next start just asks the server again.
  }
}

/** Reads them from the server: at start-up (each events hello) and whenever another window changes them. */
export function refreshFeatures(): void {
  // A promise from the start, so a mocked or older client's failure is logged rather than thrown.
  Promise.resolve()
    .then(() => api.settings.get())
    .then((settings) => {
      if (settings) applyFeatures(settings);
    })
    .catch((err: unknown) => console.error('[otherbench-web] failed to load the feature switches:', err));
}
