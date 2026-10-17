import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { OWN_COMMANDS, type CommandRow } from '@otherbench/core/domain/context-lines.js';
import type { Container } from '../container.js';
import { resolveProfile } from '../profile-resolution.js';
import { workspaceResolver } from '../workspace-view.js';

/** How long the menu waits for the engine's own commands before showing OtherBench's alone. */
export const COMMANDS_TIMEOUT_MS = 3000;

/** Shown under the menu when the engine's commands couldn't be had. */
export const COMMANDS_WARNING = "Couldn't load this chat's own commands.";

/** The engine's command rows for a chat, or a rejection after `ms`. */
function withTimeout(list: Promise<CommandRow[]>, ms: number): Promise<CommandRow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No command list after ${ms} ms.`)), ms);
  });
  return Promise.race([list, timeout]).finally(() => clearTimeout(timer));
}

/**
 * `GET /chats/:id/commands?profileId=<id>` (spec 2026-10-17-claude-slash-commands):
 * the slash menu for a chat, OtherBench's own commands first, then those its
 * engine reports (a Claude Code chat's skills and allowed built-ins). The
 * profile defaults to the chat's. When the engine can't say in time, or fails,
 * the menu is OtherBench's own commands and a warning.
 */
export function commandsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/chats/:id/commands', async (c) => {
    const chatId = c.req.param('id');
    const chat = container.store.chats.get(chatId);
    if (!chat) throw new HTTPException(404, { message: `Chat "${chatId}" not found.` });
    const profileId = c.req.query('profileId') || chat.profileId;
    if (!profileId || !container.store.profiles.get(profileId)) throw new HTTPException(404, { message: `Profile "${profileId ?? ''}" not found.` });

    const own = new Set(OWN_COMMANDS.map((row) => row.name));
    try {
      const profile = await resolveProfile(container, profileId);
      const status = workspaceResolver(container)(chat.workspace);
      const workspaceRoot = status.status === 'ok' ? status.root : null;
      const rows = container.engine.listCommands ? await withTimeout(container.engine.listCommands({ chatId, profile, workspaceRoot }), COMMANDS_TIMEOUT_MS) : [];
      return c.json({ commands: [...OWN_COMMANDS, ...rows.filter((row) => !own.has(row.name))] });
    } catch (err) {
      console.warn(`[otherbench-server] could not list chat ${chatId}'s commands:`, err instanceof Error ? err.message : err);
      return c.json({ commands: [...OWN_COMMANDS], warning: COMMANDS_WARNING });
    }
  });

  return app;
}
