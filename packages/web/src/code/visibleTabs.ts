/** The first `fits` tabs in order, except that the selected tab is always shown: if it would overflow, it takes the last visible slot. */
export function visibleTabs<T extends { id: string }>(tabs: T[], selected: string, fits: number): { shown: T[]; overflow: T[] } {
  if (fits >= tabs.length) return { shown: tabs, overflow: [] };
  const count = Math.max(1, fits);
  const picked = new Set(tabs.slice(0, count).map((t) => t.id));
  const sel = tabs.find((t) => t.id === selected);
  if (sel && !picked.has(sel.id)) {
    picked.delete(tabs[count - 1]?.id ?? '');
    picked.add(sel.id);
  }
  return { shown: tabs.filter((t) => picked.has(t.id)), overflow: tabs.filter((t) => !picked.has(t.id)) };
}
