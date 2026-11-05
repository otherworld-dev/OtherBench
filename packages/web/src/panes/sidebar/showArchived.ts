import { useState } from 'react';

/** localStorage key: whether the "Show archived" section is open. Per device. */
export const SHOW_ARCHIVED_STORAGE_KEY = 'otherbench.showArchived';

function loadShowArchived(): boolean {
  try {
    return window.localStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Whether the sidebar's "Show archived" section is open, and its toggle, which this device remembers. */
export function useShowArchived(): [showArchived: boolean, toggleArchived: () => void] {
  const [showArchived, setShowArchived] = useState(loadShowArchived);

  function toggleArchived(): void {
    const next = !showArchived;
    setShowArchived(next);
    try {
      window.localStorage.setItem(SHOW_ARCHIVED_STORAGE_KEY, String(next));
    } catch {
      // storage blocked or full -- the toggle still applies for this session.
    }
  }

  return [showArchived, toggleArchived];
}
