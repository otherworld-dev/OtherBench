import {
  APP_ARG_FIELDS,
  cardLine,
  classifyTarget,
  COMPUTER_ACTIONS,
  COMPUTER_LIMITS,
  COMPUTER_TOOL,
  COMPUTER_UNATTENDED_REASON,
  describedCallArgs,
  expectationOf,
  isReadAction,
  parseAction,
  type ComputerLook,
  type ParsedAction,
} from '@grunt/core/domain/computer-apps.js';
import type { ComputerAction, ComputerAnswer, ComputerDriver, ComputerExpectation } from '@grunt/core/ports/computer.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { DescribedCall, ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';

/**
 * The `computer` tool (spec 2026-10-12-computer-use-design section 4). The
 * desktop shell carries it out through a `ComputerDriver`; this module
 * decides nothing about apps, keys or risk. Every rule is core's
 * (domain/computer-apps.ts), and this only puts the steps in order:
 *
 *   - `describeCall` throws away every app field the model sent, has core
 *     build the one action that may be carried out (`parseAction`), starts the
 *     control session, asks the driver what the action would land on and has
 *     core describe that target once (`classifyTarget`). The described
 *     arguments are that action and that target and nothing else
 *     (`describedCallArgs`), so the card, the grant, the audit and `execute`
 *     all read the same frozen object.
 *   - `execute` gets those described arguments, builds the action again the
 *     same way and hands the driver the action and the expectation
 *     (`expectationOf`). It never asks what the target is a second time: the
 *     driver refuses when the live window no longer has the approved facts.
 */

export const COMPUTER_TOOL_DESCRIPTION = [
  'See and use the apps on this computer: take a screenshot, move and click the mouse, scroll, type and press keys.',
  "Coordinates are in the last screenshot's pixels: take a screenshot first, and again whenever the screen may have changed.",
  "Each app needs the user's approval before you can use it. Some are asked about for every single action: terminals, browsers, code editors, File Explorer, Settings, and any Open or Save dialog.",
  'A key action presses one key combination, such as "ctrl+s" or "Return": send each combination as its own action.',
  'Combinations with the Windows key, alt+tab, alt+f4, ctrl+escape, ctrl+alt+anything and Print Screen are never sent.',
  `A type action types at most ${COMPUTER_LIMITS.typeTextLength} characters; the only control characters it types are line breaks and tabs.`,
  'When an action is refused because the window changed, take a screenshot and try again.',
  'The user can stop you at any time. Use this only when no other tool or website can do the job.',
].join(' ');

export const COMPUTER_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...COMPUTER_ACTIONS] },
    coordinate: {
      type: 'array',
      items: { type: 'number' },
      minItems: 2,
      maxItems: 2,
      description: "[x, y] in the last screenshot's pixels.",
    },
    text: {
      type: 'string',
      description:
        `For type: the text to type, at most ${COMPUTER_LIMITS.typeTextLength} characters (line breaks and tabs are the only control characters typed). ` +
        'For key: one key combination, such as "Return", "ctrl+s" or "shift+tab".',
    },
    scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    scroll_amount: {
      type: 'integer',
      minimum: COMPUTER_LIMITS.scrollAmountMin,
      maximum: COMPUTER_LIMITS.scrollAmountMax,
      description: `For scroll: how far, ${COMPUTER_LIMITS.scrollAmountMin} to ${COMPUTER_LIMITS.scrollAmountMax} (${COMPUTER_LIMITS.scrollAmountDefault} when left out).`,
    },
    duration: { type: 'number', minimum: 0, maximum: COMPUTER_LIMITS.waitMax, description: `For wait: seconds, at most ${COMPUTER_LIMITS.waitMax}.` },
  },
  required: ['action'],
};

/** What an action with a coordinate is refused with before its chat has taken a screenshot. */
export const COMPUTER_NO_SCREENSHOT_REASON = "Take a screenshot first: a point is in the last screenshot's pixels, and this chat has not taken one yet.";

const NOT_STARTED_REASON = "The user didn't let Grunt control the computer.";
const STOPPED_REASON = 'The reply was stopped, so nothing was done.';
const NO_EXPECTATION_REASON = 'Grunt has no approved app and window for this action, so it did nothing.';
const LOOK_AGAIN = 'Take a screenshot to see the screen as it is now before you try again.';

/** Actions the model is shown the result of: a screenshot follows them. */
const FOLLOW_UP: ReadonlySet<string> = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'scroll', 'type', 'key']);
const DEFAULT_SETTLE_MS = 300;
const MAX_CHAT_TITLE = 80;
const MAX_DRIVER_TEXT = 300;

interface ToolError {
  error: true;
  code: string;
  message: string;
}

const fail = (code: string, message: string): ToolError => ({ error: true, code, message });
const line = (text: string): { type: 'text'; text: string } => ({ type: 'text', text });

/**
 * Whether nobody is there to watch this call. Only a plain `false`, or
 * nothing at all, says someone is: any other value counts as unattended (the
 * broker's rule, domain/permissions.ts; a test holds the two together).
 */
export function isUnattendedRun(ctx: { unattended?: unknown }): boolean {
  return ctx.unattended !== undefined && ctx.unattended !== false;
}

// ---------------------------------------------------------------------------
// The last screenshot's size, per chat

interface ScreenSize {
  width: number;
  height: number;
}

/** How many chats' screenshot sizes one driver's tools remember. Only one chat controls the computer at a time, so this is never near. */
export const MAX_REMEMBERED_SCREENS = 64;

/**
 * The size of the last screenshot each chat took: what a coordinate is
 * checked against before a card is raised. It is the tool's memory and can
 * be stale; it only lets the tool refuse early. The driver checks a point
 * against its own last screenshot when it acts, and is the authority.
 *
 * Bounded: a chat's entry goes when its control session is stopped or can't
 * be started, and the chat whose screenshot is the oldest goes once there are
 * more than `MAX_REMEMBERED_SCREENS`. A chat with no entry is asked to take a
 * screenshot before it can use a point.
 */
class ScreenSizes {
  private readonly byChat = new Map<string, ScreenSize>();

  get(chatId: string): ScreenSize | undefined {
    return this.byChat.get(chatId);
  }

  remember(chatId: string, size: ScreenSize): void {
    this.byChat.delete(chatId);
    this.byChat.set(chatId, Object.freeze({ width: size.width, height: size.height }));
    if (this.byChat.size > MAX_REMEMBERED_SCREENS) {
      const oldest = this.byChat.keys().next();
      if (!oldest.done) this.byChat.delete(oldest.value);
    }
  }

  forget(chatId: string): void {
    this.byChat.delete(chatId);
  }
}

/**
 * One memory per driver, shared by every tool built for it: the provider
 * builds the spec anew for each turn (and again for the Claude Code relay),
 * and a click in one turn is checked against the screenshot of an earlier one.
 */
const SCREENS = new WeakMap<ComputerDriver, ScreenSizes>();

function screensOf(driver: ComputerDriver): ScreenSizes {
  let screens = SCREENS.get(driver);
  if (screens === undefined) {
    const made = new ScreenSizes();
    // The shell ended the session (the stop hotkey, Stop, idle, quit): the next session starts with a screenshot.
    driver.onStopped((chatId) => made.forget(chatId));
    SCREENS.set(driver, made);
    screens = made;
  }
  return screens;
}

// ---------------------------------------------------------------------------

function isLook(action: ComputerLook | ComputerAction): action is ComputerLook {
  return isReadAction(action.action);
}

/** The model's arguments without the fields a described target occupies: whatever it put there is gone before anything is read. */
function withoutAppFields(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const args: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const field of APP_ARG_FIELDS) delete args[field];
  return args;
}

/** What the driver (or an error from it) said, as one bounded plain line. */
function driverText(text: unknown): string {
  return cardLine(text, MAX_DRIVER_TEXT);
}

function errorText(err: unknown): string {
  return driverText(err instanceof Error ? err.message : String(err)) || 'the desktop app gave no reason';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function computerTool(driver: ComputerDriver, store: Store, options: { settleMs?: number } = {}): ToolSpec {
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const screens = screensOf(driver);

  /**
   * The one action that may be carried out, or why there is none. The only
   * way an action is built, in `describeCall` and again in `execute`, with
   * the same options both times: the size of the chat's last screenshot, and
   * the shell's shortcuts exactly as the driver gives them (`null` included:
   * core then refuses every `key` action).
   */
  const parse = (args: unknown, chatId: string): ParsedAction => {
    const bounds = screens.get(chatId);
    const parsed = parseAction(args, { ...(bounds !== undefined ? { bounds } : {}), reserved: driver.reservedKeys() });
    if (parsed.ok && 'coordinate' in parsed.action && bounds === undefined) return { ok: false, reason: COMPUTER_NO_SCREENSHOT_REASON };
    return parsed;
  };

  /** Starts (or continues) the chat's control session; the shell shows its native dialog the first time. The reason it didn't start, or null. */
  const startSession = async (ctx: ToolContext): Promise<string | null> => {
    const title = cardLine(store.chats.get(ctx.chatId)?.title, MAX_CHAT_TITLE) || 'this chat';
    const session: ComputerAnswer = await driver.ensureSession(ctx.chatId, title);
    if (session.ok === true) return null;
    screens.forget(ctx.chatId);
    return driverText(session.reason) || NOT_STARTED_REASON;
  };

  const shoot = async (chatId: string): Promise<unknown[]> => {
    const shot = await driver.screenshot(chatId);
    const { width, height, png } = shot;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !Buffer.isBuffer(png) || png.length === 0) {
      screens.forget(chatId);
      throw new Error('The screenshot came back without a usable image or size.');
    }
    screens.remember(chatId, { width, height });
    // The shape every tool-result image has (core's tool-images.ts): the runner stores it and the engines show it.
    return [line(`Screenshot, ${width}×${height}.`), { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }];
  };

  const look = async (action: ComputerLook, ctx: ToolContext): Promise<unknown> => {
    switch (action.action) {
      case 'screenshot':
        return shoot(ctx.chatId);
      case 'cursor_position': {
        const at = await driver.cursorPosition(ctx.chatId);
        if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error("The cursor's position came back unreadable.");
        return [line(`The cursor is at ${at.x}, ${at.y}.`)];
      }
      case 'wait':
        // Waited here, never by the shell, and ended early when the reply is stopped.
        await sleep(action.duration * 1000, ctx.signal);
        return ctx.signal.aborted ? fail('cancelled', STOPPED_REASON) : [line(`Waited ${action.duration} s.`)];
    }
  };

  const carryOut = async (action: ComputerAction, expectation: ComputerExpectation, ctx: ToolContext): Promise<unknown> => {
    let done: ComputerAnswer;
    try {
      done = await driver.act(ctx.chatId, action, expectation);
    } catch (err) {
      return fail('computer_failed', `${errorText(err)} Grunt can't tell whether the action was carried out. ${LOOK_AGAIN}`);
    }
    // The driver stops at the first check that fails, which can be part-way through typing: the model has to look.
    if (done.ok !== true) return fail('computer_refused', `${driverText(done.reason) || 'The desktop app refused the action.'} ${LOOK_AGAIN}`);
    if (!FOLLOW_UP.has(action.action)) return [line('Done.')];
    // Let the app redraw, then show the model what happened. Not once the reply was stopped.
    await sleep(settleMs, ctx.signal);
    if (ctx.signal.aborted) return [line('Done.')];
    try {
      return [line('Done.'), ...(await shoot(ctx.chatId))];
    } catch (err) {
      // The action WAS carried out: say so, or the model would do it again.
      return [line('Done.'), line(`Grunt couldn't take a screenshot afterwards (${errorText(err)}). Take one before the next action.`)];
    }
  };

  return {
    name: COMPUTER_TOOL,
    description: COMPUTER_TOOL_DESCRIPTION,
    parameters: COMPUTER_TOOL_PARAMETERS,
    risk: 'mutate',
    source: 'computer',

    describeCall: async (raw, ctx): Promise<DescribedCall> => {
      const parsed = parse(withoutAppFields(raw), ctx.chatId);
      if (!parsed.ok) return { refuse: parsed.reason };
      const action = parsed.action;
      // A look has no target and no expectation.
      if (isLook(action)) return { args: { ...action, app: null }, risk: 'read' };
      // The broker refuses an unattended call too, but only after this, and
      // no native dialog may appear in a run nobody is watching.
      if (isUnattendedRun(ctx)) return { refuse: COMPUTER_UNATTENDED_REASON };
      // A reply that was already stopped starts nothing: no dialog comes up for it.
      if (ctx.signal.aborted) return { refuse: STOPPED_REASON };
      // The session before the target: the driver tells nothing without one,
      // and finding out what is under a point is itself reading the screen.
      // The native dialog is the consent for that.
      let notStarted: string | null;
      try {
        notStarted = await startSession(ctx);
      } catch (err) {
        return { refuse: `Grunt couldn't start controlling the computer: ${errorText(err)}` };
      }
      if (notStarted !== null) return { refuse: notStarted };
      // The dialog can wait on a person for a long time; a reply stopped meanwhile reads nothing.
      if (ctx.signal.aborted) return { refuse: STOPPED_REASON };
      let target: unknown;
      try {
        target = await driver.target(ctx.chatId, 'coordinate' in action ? { x: action.coordinate[0], y: action.coordinate[1] } : 'foreground');
      } catch (err) {
        return { refuse: `Grunt couldn't tell which app that is: ${errorText(err)}` };
      }
      const described = classifyTarget(target);
      if (described.kind === 'refuse') return { refuse: described.reason };
      // The parsed action and the described target, and nothing the model sent.
      return { args: describedCallArgs(action, described), risk: 'mutate' };
    },

    execute: async (args, ctx): Promise<unknown> => {
      try {
        // The broker has refused this already; nothing here may run in a run nobody is watching, whoever calls it.
        if (isUnattendedRun(ctx)) return fail('computer_not_allowed', COMPUTER_UNATTENDED_REASON);
        const parsed = parse(args, ctx.chatId);
        if (!parsed.ok) return fail('computer_bad_action', parsed.reason);
        const action = parsed.action;
        // No acting without an expectation: the app, the file-view fact, the window and the run the card was about.
        const expectation = isLook(action) ? null : expectationOf(args);
        if (!isLook(action) && expectation === null) return fail('computer_bad_call', NO_EXPECTATION_REASON);
        // A reply that was already stopped starts nothing: no dialog comes up for it.
        if (ctx.signal.aborted) return fail('cancelled', STOPPED_REASON);

        // The session first, for the looks too: the native dialog is the consent to see the screen.
        const notStarted = await startSession(ctx);
        if (notStarted !== null) return fail('computer_not_allowed', notStarted);
        // The dialog can wait on a person for a long time; a reply stopped meanwhile must not act when it comes back.
        if (ctx.signal.aborted) return fail('cancelled', STOPPED_REASON);

        if (isLook(action)) return await look(action, ctx);
        if (expectation === null) return fail('computer_bad_call', NO_EXPECTATION_REASON);
        return await carryOut(action, expectation, ctx);
      } catch (err) {
        return fail('computer_failed', errorText(err));
      }
    },
  };
}
