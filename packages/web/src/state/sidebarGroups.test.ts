import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAPSED_GROUPS_STORAGE_KEY,
  NO_PROJECT_KEY,
  groupDomId,
  resetSidebarGroupsForTests,
  revealSidebarGroup,
  setGroupCollapsed,
  useCollapsedGroups,
} from './sidebarGroups.js';

beforeEach(() => {
  window.localStorage.clear();
  resetSidebarGroupsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sidebar group collapse state', () => {
  it('remembers collapsed groups in localStorage', () => {
    const { result } = renderHook(() => useCollapsedGroups());
    act(() => {
      setGroupCollapsed('p-a', true);
      setGroupCollapsed(NO_PROJECT_KEY, true);
      setGroupCollapsed('p-a', false);
    });

    expect([...result.current]).toEqual([NO_PROJECT_KEY]);
    expect(JSON.parse(window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)!)).toEqual([NO_PROJECT_KEY]);
  });

  it('reads the saved set back on first use', () => {
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(['p-b']));
    const { result } = renderHook(() => useCollapsedGroups());
    expect(result.current.has('p-b')).toBe(true);
  });

  it('treats unreadable or malformed storage as nothing collapsed, keeping valid entries', () => {
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, '{not json');
    expect(renderHook(() => useCollapsedGroups()).result.current.size).toBe(0);

    resetSidebarGroupsForTests();
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(['ok', 3, null]));
    expect([...renderHook(() => useCollapsedGroups()).result.current]).toEqual(['ok']);
  });

  it('still collapses for this session when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useCollapsedGroups());
    act(() => setGroupCollapsed('p-a', true));
    expect(result.current.has('p-a')).toBe(true);
  });

  it('revealSidebarGroup expands the group and scrolls to it', () => {
    const target = document.createElement('div');
    target.id = groupDomId('p-a');
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    const { result } = renderHook(() => useCollapsedGroups());
    act(() => setGroupCollapsed('p-a', true));

    act(() => revealSidebarGroup('p-a'));

    expect(result.current.has('p-a')).toBe(false);
    expect(target.scrollIntoView).toHaveBeenCalled();
    target.remove();
  });
});
