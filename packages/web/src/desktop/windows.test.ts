import { afterEach, describe, expect, it } from 'vitest';
import { loadUndocked, parseOpenRequest, parseUndocked, saveUndocked, UNDOCKED_STORAGE_KEY, windowForMode, windowRole } from './windows.js';

describe('undocked windows', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('knows its window from the query or the shell label, and is the main one otherwise', () => {
    expect(windowRole()).toBe('main');
    window.history.replaceState(null, '', '/?view=code');
    expect(windowRole()).toBe('code');
    window.history.replaceState(null, '', '/?view=overview');
    expect(windowRole()).toBe('overview');
    window.history.replaceState(null, '', '/?view=quick');
    expect(windowRole()).toBe('main');
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: 'code' } } };
    expect(windowRole()).toBe('code');
  });

  it("keeps only the views that can be undocked, once each", () => {
    expect(parseUndocked(['overview', 'code', 'code', 'main', 3])).toEqual(['code', 'overview']);
    expect(parseUndocked('code')).toEqual([]);
    expect(parseUndocked(null)).toEqual([]);
  });

  it('remembers the list only in the desktop app', () => {
    saveUndocked(['code']);
    expect(window.localStorage.getItem(UNDOCKED_STORAGE_KEY)).toBe('["code"]');
    expect(loadUndocked()).toEqual([]);
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    expect(loadUndocked()).toEqual(['code']);
    window.localStorage.setItem(UNDOCKED_STORAGE_KEY, '{not json');
    expect(loadUndocked()).toEqual([]);
  });

  it('puts Code mode in its own window while undocked, and always from inside that window', () => {
    expect(windowForMode('code', [], 'main')).toBe('main');
    expect(windowForMode('code', ['code'], 'main')).toBe('code');
    expect(windowForMode('code', ['overview'], 'overview')).toBe('main');
    // The Code window holds Code mode before the shell's list reaches it.
    expect(windowForMode('code', [], 'code')).toBe('code');
    expect(windowForMode('chat', ['code', 'overview'], 'code')).toBe('main');
  });

  it('reads only well-formed open requests', () => {
    expect(parseOpenRequest({ kind: 'chat', chatId: 'c1' })).toEqual({ kind: 'chat', chatId: 'c1' });
    expect(parseOpenRequest({ kind: 'issue', appId: 'a', n: 4, state: 'open', extra: 1 })).toEqual({ kind: 'issue', appId: 'a', n: 4, state: 'open' });
    expect(parseOpenRequest({ kind: 'card', appId: 'a', cardId: 9 })).toEqual({ kind: 'card', appId: 'a', cardId: 9 });
    expect(parseOpenRequest({ kind: 'issue', appId: 'a', n: 1.5, state: 'open' })).toBeNull();
    expect(parseOpenRequest({ kind: 'issue', appId: 'a', n: 1, state: 'merged' })).toBeNull();
    expect(parseOpenRequest({ kind: 'chat', chatId: '' })).toBeNull();
    expect(parseOpenRequest({ kind: 'delete', chatId: 'c1' })).toBeNull();
    expect(parseOpenRequest('chat')).toBeNull();
  });
});
