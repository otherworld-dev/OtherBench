import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  mayChangePeerComputerControl,
  PEER_COMPUTER_CONTROL_ASKING_REASON,
  PEER_COMPUTER_CONTROL_CONFIRM_TEXT,
  PEER_COMPUTER_CONTROL_HOST_ONLY_REASON,
  PEER_COMPUTER_CONTROL_IN_CONTROL_REASON,
  PEER_COMPUTER_CONTROL_NO_DESKTOP_REASON,
  peerComputerControlNeedsHostConfirm,
  peerComputerControlNotConfirmedReason,
  START_COMMAND_MAX,
} from '@otherbench/core/domain/settings.js';
import type { AppSettings, Store } from '@otherbench/core/ports/store.js';
import { fromTheDesktopApp } from '../computer/desktop-only.js';
import type { Container } from '../container.js';
import { optionalNullableString } from '../validation.js';

interface SettingsBody {
  memoryProfileId?: unknown;
  githubEnabled?: unknown;
  nextcloudEnabled?: unknown;
  peerComputerControl?: unknown;
  peerScheduleControl?: unknown;
  handoverEnabled?: unknown;
  handoverThresholdTokens?: unknown;
  deckStartCommand?: unknown;
  issueStartCommand?: unknown;
}

const FEATURES = ['githubEnabled', 'nextcloudEnabled'] as const;
/** What the Deck and Issues tabs' Chat buttons send first (`fillStartCommand`); empty = send nothing. */
const START_COMMANDS = ['deckStartCommand', 'issueStartCommand'] as const;

/** The fresh chat card's threshold, in tokens per call: below 50k it would ask about ordinary chats, above 2M no model reaches it. */
export const HANDOVER_THRESHOLD_MIN = 50_000;
export const HANDOVER_THRESHOLD_MAX = 2_000_000;

/** Sets the Memory model back to "Project default" when `profileId` was it -- for a profile just archived or deleted. */
export function clearMemoryProfile(store: Store, profileId: string): void {
  if (store.settings.get().memoryProfileId === profileId) store.settings.update({ memoryProfileId: null });
}

/**
 * `GET/PATCH /api/settings`: app-wide settings (spec 2026-10-03-project-memory-design §4), GitHub and Nextcloud on or
 * off (`features.ts`), whether paired machines may start and approve computer use here (`peerComputerControl`), and
 * whether they may manage this machine's schedules (`peerScheduleControl`). Not on the peer listener: only this machine's own UI changes them.
 *
 * `peerComputerControl` is turned on only with the OK of the person at this machine, in the desktop app's native
 * dialog (`container.hostConfirm`, over the shell's private channel, which no HTTP client can reach): no desktop app,
 * Cancel, nobody answering, or computer use possibly in control here, and it stays off. A request whose `Origin`
 * isn't the desktop app's (`desktopOrigins`, the shell's `--cors-origin`s) is refused before anyone is asked, so a
 * browser tab or a phone gets a clear answer and no dialog pops up here for it; that header can be forged, so it is
 * only the early refusal, never the boundary. Turning it off needs neither, from anywhere.
 */
export function settingsRoutes(container: Container, desktopOrigins: readonly string[] = []): Hono {
  const app = new Hono();
  // One question at a time: a second switch-on while the first is being asked is refused, not queued.
  let asking = false;

  app.get('/', (c) => c.json(container.store.settings.get()));

  app.patch('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SettingsBody;
    // Every field is validated before anything is written.
    const patch: Partial<AppSettings> = {};
    if (body.memoryProfileId !== undefined) {
      const id = optionalNullableString(body.memoryProfileId, 'memoryProfileId') ?? null;
      if (id !== null) {
        const profile = container.store.profiles.get(id);
        if (!profile) throw new HTTPException(400, { message: `"memoryProfileId": profile "${id}" not found.` });
        if (profile.archivedAt !== null) throw new HTTPException(400, { message: `"memoryProfileId": profile "${profile.name}" is archived.` });
      }
      patch.memoryProfileId = id;
    }
    for (const key of FEATURES) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new HTTPException(400, { message: `"${key}" must be true or false.` });
      patch[key] = value;
    }
    if (body.handoverEnabled !== undefined) {
      if (typeof body.handoverEnabled !== 'boolean') throw new HTTPException(400, { message: '"handoverEnabled" must be true or false.' });
      patch.handoverEnabled = body.handoverEnabled;
    }
    if (body.handoverThresholdTokens !== undefined) {
      const n = body.handoverThresholdTokens;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < HANDOVER_THRESHOLD_MIN || n > HANDOVER_THRESHOLD_MAX) {
        throw new HTTPException(400, { message: `"handoverThresholdTokens" must be a whole number from ${HANDOVER_THRESHOLD_MIN} to ${HANDOVER_THRESHOLD_MAX}.` });
      }
      patch.handoverThresholdTokens = n;
    }
    for (const key of START_COMMANDS) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw new HTTPException(400, { message: `"${key}" must be a string.` });
      const command = value.trim();
      if (command.length > START_COMMAND_MAX) throw new HTTPException(400, { message: `"${key}" must be at most ${START_COMMAND_MAX} characters.` });
      patch[key] = command;
    }
    // Whether paired machines may start and approve computer use here (peer/forward.ts reads it on every call).
    if (body.peerComputerControl !== undefined) {
      if (typeof body.peerComputerControl !== 'boolean') throw new HTTPException(400, { message: '"peerComputerControl" must be true or false.' });
      patch.peerComputerControl = body.peerComputerControl;
    }
    // Whether paired machines may manage this machine's schedules (peer/schedule-control.ts reads it on every call).
    // A plain switch, unlike the one above: it hands over no mouse or keyboard, and a run it makes is unattended, so
    // anything that would need a card is refused. Not on the peer listener, so only this machine changes it.
    if (body.peerScheduleControl !== undefined) {
      if (typeof body.peerScheduleControl !== 'boolean') throw new HTTPException(400, { message: '"peerScheduleControl" must be true or false.' });
      patch.peerScheduleControl = body.peerScheduleControl;
    }
    const current = container.store.settings.get();
    if (patch.peerComputerControl !== undefined && peerComputerControlNeedsHostConfirm(current.peerComputerControl, patch.peerComputerControl)) {
      // The early refusal (forgeable, so not the boundary): it doesn't even claim to be the desktop app.
      if (!mayChangePeerComputerControl(current.peerComputerControl, true, fromTheDesktopApp(c.req.header('Origin'), desktopOrigins))) {
        return c.json({ error: PEER_COMPUTER_CONTROL_HOST_ONLY_REASON, kind: 'desktop_app_only' }, 403);
      }
      const confirmer = container.hostConfirm;
      if (!confirmer) return c.json({ error: PEER_COMPUTER_CONTROL_NO_DESKTOP_REASON, kind: 'desktop_app_only' }, 403);
      // Nobody is asked while a model may be at the screen.
      if (container.computer?.mayBeInControl() === true) return c.json({ error: PEER_COMPUTER_CONTROL_IN_CONTROL_REASON, kind: 'desktop_only' }, 403);
      if (asking) return c.json({ error: PEER_COMPUTER_CONTROL_ASKING_REASON, kind: 'already_asking' }, 409);
      asking = true;
      let answer: { ok: true } | { ok: false; reason: string };
      try {
        // The boundary: only the person's OK in the desktop app's own dialog on this machine.
        answer = await confirmer.confirm(PEER_COMPUTER_CONTROL_CONFIRM_TEXT);
      } catch (err) {
        console.error('[otherbench-server] the desktop app could not ask about letting paired machines in:', err);
        answer = { ok: false, reason: "The desktop app couldn't ask." };
      } finally {
        asking = false;
      }
      // Nothing in the request is written unless the person said OK.
      if (answer.ok !== true) return c.json({ error: peerComputerControlNotConfirmedReason(answer.reason), kind: 'not_confirmed' }, 403);
    }
    const before = container.store.settings.get();
    const after = container.store.settings.update(patch);
    const handoverChanged = before.handoverEnabled !== after.handoverEnabled || before.handoverThresholdTokens !== after.handoverThresholdTokens;
    const startCommandsChanged = START_COMMANDS.some((key) => before[key] !== after[key]);
    const peerControlChanged = before.peerComputerControl !== after.peerComputerControl || before.peerScheduleControl !== after.peerScheduleControl;
    if ((peerControlChanged || handoverChanged || startCommandsChanged) && !FEATURES.some((key) => before[key] !== after[key])) {
      container.events?.emit({ type: 'settings-changed' });
    }
    if (FEATURES.some((key) => before[key] !== after[key])) {
      // Every window re-reads the settings, and the Overview drops or brings back its GitHub and Deck sections now.
      container.events?.emit({ type: 'settings-changed' });
      container.overview?.refresh().catch((err: unknown) => console.error('[otherbench-server] the overview check failed:', err));
    }
    return c.json(after);
  });

  return app;
}
