import { COMPUTER_SCREEN_ABOUT } from '@otherbench/core/domain/computer-apps.js';
import { FAKE_COMPUTER_APP, FAKE_PNG, FakeComputerDriver, fakeComputerTarget } from '@otherbench/core/testing/fake-computer.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { ToolPolicy } from '@otherbench/core/types/config.js';
import { computerTool } from '../src/computer-tool.js';

/**
 * What the computer tool's tests share. Every one of them uses
 * `FakeComputerDriver`: nothing moves a real mouse, presses a real key or
 * reads a real screen.
 */

/** The fake app's key: its path exactly as the driver reports it, never lower-cased. */
export const KEY = FAKE_COMPUTER_APP.path;

/** The described target of the fake app, as `describeCall` puts it in a call's arguments. */
export const APP = {
  app: KEY,
  appName: 'FakeApp.exe',
  appTitle: 'Fake App',
  appRisk: 'normal',
  appShellView: false,
  appWindow: 'hwnd-1',
  appPid: 4242,
  appStarted: '2026-10-12T09:00:00.000Z',
};

/** What the driver must still find true when it acts on the fake app. */
export const EXPECT = { app: KEY, shellView: false, windowId: 'hwnd-1', pid: 4242, startedAt: '2026-10-12T09:00:00.000Z' };

/** The line every result with something from the screen in it begins with. */
export const ABOUT = { type: 'text', text: COMPUTER_SCREEN_ABOUT };

/** A screenshot's own line and its image. */
const SHOT_ITEMS = [
  { type: 'text', text: 'Screenshot, 1366\u00d7768.' },
  { type: 'image', data: FAKE_PNG.toString('base64'), mimeType: 'image/png' },
];

/** What a screenshot is answered with. */
export const SHOT = [ABOUT, ...SHOT_ITEMS];

export const DONE = { type: 'text', text: 'Done.' };

/** What an action that is followed by a screenshot is answered with. */
export const AFTER = [ABOUT, DONE, ...SHOT_ITEMS];

/** A program on the high-risk list: only ever "Allow once". */
export const EXPLORER = fakeComputerTarget({ path: 'C:\\Windows\\explorer.exe', originalName: 'EXPLORER.EXE', title: 'Documents' });

/** Every kind of value of `ctx.unattended` but "someone is there" (`undefined`, `false`). */
export const UNATTENDED: unknown[] = [true, 'true', 1, null, {}];

export function policy(over: Partial<ToolPolicy> = {}): ToolPolicy {
  return { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', computer: true, ...over };
}

export function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal, ...over };
}

export function unattendedCtx(value: unknown): ToolContext {
  return ctx({ unattended: value as boolean });
}

export function setup() {
  const store = new InMemoryStore();
  store.chats.create({ id: 'chat-1', title: 'Budget sheet', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  const driver = new FakeComputerDriver();
  return { store, driver, tool: computerTool(driver, store, { settleMs: 0 }) };
}

/** The names of the driver calls made from here on, in order. */
export function recordCalls(driver: FakeComputerDriver): string[] {
  const calls: string[] = [];
  for (const name of ['ensureSession', 'target', 'act', 'screenshot', 'cursorPosition'] as const) {
    const real = (driver[name] as (...a: unknown[]) => unknown).bind(driver);
    (driver as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
      calls.push(name);
      return real(...a);
    };
  }
  return calls;
}
