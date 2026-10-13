import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import { useViewerStore, viewerFor } from './state.js';
import { browserCalls, useBrowserAutoOpen } from './useBrowserAutoOpen.js';

const msg = (id: string, status: CanonMessage['status'], parts: Part[]): CanonMessage =>
  ({ id, chatId: 'c1', parentId: null, role: 'assistant', parts, status, error: null, producedBy: null, createdAt: 1 }) as CanonMessage;
const call = (id: string, name = 'browser'): Part => ({ type: 'tool-call', id, name, args: { command: 'open', url: 'https://example.com/' } });
const viewer = () => viewerFor(useViewerStore.getState().viewers, 'c1');

beforeEach(() => useViewerStore.setState({ viewers: {} }));

describe('useBrowserAutoOpen', () => {
  it('lists browser calls with whether their reply is still running', () => {
    expect(browserCalls([msg('a', 'complete', [call('t1'), call('t2', 'recall')]), msg('b', 'streaming', [call('t3')])])).toEqual([
      { messageId: 'a', callId: 't1', live: false },
      { messageId: 'b', callId: 't3', live: true },
    ]);
  });

  it("opens the viewer on the browser for a new call in a running reply, never for history", () => {
    const old = msg('a', 'complete', [call('t1')]);
    const { rerender } = renderHook(({ messages, open }) => useBrowserAutoOpen('c1', messages, open), { initialProps: { messages: [old], open: false } });
    expect(viewer().open).toBe(false);
    act(() => rerender({ messages: [old, msg('b', 'streaming', [call('t2')])], open: false }));
    expect(viewer()).toMatchObject({ open: true, mode: 'item', history: [{ kind: 'browser' }] });
  });

  it('opens it once per reply: a later call in the same reply leaves the viewer on whatever the user turned to', () => {
    const { rerender } = renderHook(({ messages, open }) => useBrowserAutoOpen('c1', messages, open), { initialProps: { messages: [] as CanonMessage[], open: false } });
    act(() => rerender({ messages: [msg('b', 'streaming', [call('t1')])], open: false }));
    expect(viewer()).toMatchObject({ open: true, history: [{ kind: 'browser' }] });
    act(() => useViewerStore.getState().openItem('c1', { kind: 'file', path: 'C:\\ws\\a.md' }));
    act(() => rerender({ messages: [msg('b', 'streaming', [call('t1'), call('t2')])], open: true }));
    expect(viewer().history.at(viewer().index)).toEqual({ kind: 'file', path: 'C:\\ws\\a.md' });
    // The next reply opens it on the browser again.
    act(() => rerender({ messages: [msg('b', 'complete', [call('t1'), call('t2')]), msg('c', 'streaming', [call('t3')])], open: true }));
    expect(viewer().history.at(viewer().index)).toEqual({ kind: 'browser' });
  });

  it('leaves the viewer closed for the rest of a reply once the user closed it during that reply', () => {
    const { rerender } = renderHook(({ messages, open }) => useBrowserAutoOpen('c1', messages, open), { initialProps: { messages: [] as CanonMessage[], open: false } });
    act(() => rerender({ messages: [msg('b', 'streaming', [call('t1')])], open: false }));
    expect(viewer().open).toBe(true);
    act(() => useViewerStore.getState().setOpen('c1', false));
    act(() => rerender({ messages: [msg('b', 'streaming', [call('t1')])], open: true }));
    act(() => rerender({ messages: [msg('b', 'streaming', [call('t1')])], open: false }));
    act(() => rerender({ messages: [msg('b', 'streaming', [call('t1'), call('t2')])], open: false }));
    expect(viewer().open).toBe(false);
    // The next reply opens it again.
    act(() => rerender({ messages: [msg('b', 'complete', [call('t1'), call('t2')]), msg('c', 'streaming', [call('t3')])], open: false }));
    expect(viewer().open).toBe(true);
  });

  it("doesn't take a switch to a chat with a closed viewer for the user closing it", () => {
    const other = () => viewerFor(useViewerStore.getState().viewers, 'c2');
    const { rerender } = renderHook(
      ({ chatId, messages, open }) => useBrowserAutoOpen(chatId, messages, open),
      { initialProps: { chatId: 'c1', messages: [] as CanonMessage[], open: true } }
    );
    // Chat c2 has a reply running and its viewer closed.
    act(() => rerender({ chatId: 'c2', messages: [msg('b', 'streaming', [])], open: false }));
    act(() => rerender({ chatId: 'c2', messages: [msg('b', 'streaming', [call('t1')])], open: false }));
    expect(other()).toMatchObject({ open: true, mode: 'item', history: [{ kind: 'browser' }] });
  });
});
