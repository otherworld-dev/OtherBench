import { randomUUID } from 'node:crypto';
import { agentStatusOf, type AgentStatus } from '@otherbench/core/domain/chat-status-tool.js';
import type { TurnEvent, TurnInput, TurnResult } from '@otherbench/core/domain/turn.js';
import type { Sandbox } from '@otherbench/core/ports/sandbox.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { MessageStatus } from '@otherbench/core/types/messages.js';
import { chatTip } from '../routes/chats.js';
import { INSTALL_HOSTS, SANDBOX_PLACEHOLDERS } from './git.js';

/** The longest an install or test command may run in the sandbox (run_command's own cap). */
const SANDBOX_COMMAND_MS = 600_000;
/** The end of a command's output kept in its summary. */
const OUTPUT_TAIL = 3500;
/** The most lines of `git status` an uncommitted report keeps. */
const UNCOMMITTED_LINES = 60;

/** A job's reply, as far as a job service needs it. */
export interface JobReply {
  status: MessageStatus;
  error: string | null;
  /** The reply's text parts, joined. */
  text: string;
  /** What the agent said is done and left (set_chat_status), if it said. */
  chatStatus: AgentStatus | null;
}

/**
 * Runs unattended job chats (docs/features/jobs.md). The one way anything (an add-on included) makes a job chat:
 * the chat is recorded in `job_chat` before its first turn, so TurnRunner runs every turn in it under the job rules,
 * in its folder only. Commands it runs in the sandbox have their network fixed here, never by the caller's say.
 */
export interface JobRunner {
  /** Makes a job chat held to `folder`, on this machine, never in Auto. */
  createChat(input: { title: string; folder: string; profileId: string }): { chatId: string };
  /** The profile jobs would run on (`null` = the app default), or null when there is none. */
  profile(profileId: string | null): Promise<{ id: string; name: string; archived: boolean } | null>;
  /** Starts an unattended turn from the chat's current tip. */
  startTurn(input: { chatId: string; text: string; profileId: string }): Promise<{ userMessageId: string; messageId: string }>;
  /** Told each time a reply ends (any status but streaming). Returns an unsubscribe. */
  onReplyEnded(cb: (messageId: string, status: MessageStatus) => void): () => void;
  reply(messageId: string): JobReply | null;
  chatExists(chatId: string): boolean;
  /** Stop's own cancel; `notice` is what the stopped reply ends with. */
  cancel(messageId: string, notice?: string): void;
  /** Closes the chat's engine session (its process), if it has one. */
  closeChat(chatId: string): void;
  /** Calls refused in the chat since `since`: by its rules, for nobody being there, or by policy (never a stop). */
  refusedCalls(chatId: string, since: number): number;
  /** Runs a command in the sandbox in the job folder. `install` may reach package registries only; `none` nothing. */
  runCommand(input: { chatId: string; folder: string; command: string; network: 'install' | 'none'; signal?: AbortSignal }): Promise<{ ok: boolean; summary: string }>;
  /** What the job left uncommitted, read by git status in the sandbox (never on this machine), or null. */
  uncommitted(chatId: string, folder: string): Promise<{ files: number; summary: string } | null>;
  releaseSandbox(chatId: string): Promise<void>;
}

export interface JobRunnerDeps {
  store: Store;
  startTurn: (input: TurnInput) => Promise<TurnResult>;
  turnRunner: { on(cb: (e: TurnEvent) => void): () => void; cancel(messageId: string, notice?: string): void };
  resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  defaultProfileId: () => string | null;
  sandbox: Sandbox | null;
  closeChats?: (gone: (chatId: string) => boolean) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createJobRunner(d: JobRunnerDeps): JobRunner {
  const neverAsk = async (): Promise<boolean> => false;

  async function inSandbox(chatId: string, folder: string, command: string, hosts: readonly string[], signal: AbortSignal | undefined) {
    if (!d.sandbox) return null;
    return d.sandbox.run({
      chatId,
      command,
      timeoutMs: SANDBOX_COMMAND_MS,
      fs: 'readwrite',
      workspaceRoot: folder,
      folders: [],
      allowedHosts: [...hosts],
      signal: signal ?? new AbortController().signal,
      // Never a card: a host not on the list is refused.
      askHost: neverAsk,
    });
  }

  return {
    createChat({ title, folder, profileId }) {
      const chat = d.store.chats.create({
        id: randomUUID(),
        title,
        profileId,
        headMessageId: null,
        workspace: { kind: 'machine', nodeId: d.store.nodes.self().id, root: folder },
        pinned: false,
        archivedAt: null,
        projectId: null,
        appId: null,
        autoMode: false,
        // The brief is untrusted, so nothing from it reaches a memory note (memory also skips job chats itself).
        memoryExcluded: true,
      });
      // From here the chat is a job chat: TurnRunner reads this row for every turn in it.
      d.store.jobChats.add(chat.id, folder);
      return { chatId: chat.id };
    },

    async profile(profileId) {
      const id = profileId ?? d.defaultProfileId();
      if (!id) return null;
      const p = await d.resolveProfile(id);
      return { id: p.id, name: p.name, archived: p.archivedAt !== null };
    },

    async startTurn({ chatId, text, profileId }) {
      const chat = d.store.chats.get(chatId);
      if (!chat) throw new Error("The job's chat is gone.");
      if (d.store.jobChats.folderFor(chatId) === null) throw new Error('That chat is not a job chat.');
      const profile = await d.resolveProfile(profileId);
      const parentId = chatTip(d.store, chat.id, chat.headMessageId);
      // Unattended: whatever would raise a card is refused, and questions get the unattended answer.
      const result = await d.startTurn({ chatId, parentId, userParts: [{ type: 'text', text }], profiles: [profile], unattended: true });
      const messageId = result.assistantMessageIds[0];
      if (!messageId) throw new Error('The turn started without a reply.');
      return { userMessageId: result.userMessageId, messageId };
    },

    onReplyEnded(cb) {
      return d.turnRunner.on((e) => {
        if (e.type === 'status' && e.status !== 'streaming') cb(e.messageId, e.status);
      });
    },

    reply(messageId) {
      const m = d.store.messages.get(messageId);
      if (!m) return null;
      const text = m.parts
        .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n\n')
        .trim();
      return { status: m.status, error: m.error?.message ?? null, text, chatStatus: agentStatusOf(m.parts) };
    },

    chatExists: (chatId) => d.store.chats.get(chatId) !== null,
    cancel: (messageId, notice) => d.turnRunner.cancel(messageId, notice),
    closeChat: (chatId) => d.closeChats?.((id) => id === chatId),

    refusedCalls(chatId, since) {
      return d.store.audit.list(chatId).filter((a) => a.createdAt >= since && a.grantedBy.startsWith('deny:') && a.grantedBy !== 'deny:cancelled').length;
    },

    async runCommand({ chatId, folder, command, network, signal }) {
      try {
        const r = await inSandbox(chatId, folder, command, network === 'install' ? INSTALL_HOSTS : [], signal);
        if (r === null) return { ok: false, summary: 'There is no sandbox on this machine, so it could not run.' };
        const tail = r.output.length > OUTPUT_TAIL ? `…${r.output.slice(-OUTPUT_TAIL)}` : r.output;
        const verdict = r.timedOut ? 'It timed out.' : `It exited with ${r.exitCode ?? r.signal ?? 'no code'}.`;
        return { ok: r.exitCode === 0 && !r.timedOut, summary: `${verdict}\n${tail}`.trim() };
      } catch (err) {
        return { ok: false, summary: `It couldn't run: ${errorMessage(err)}` };
      }
    },

    async uncommitted(chatId, folder) {
      try {
        const r = await inSandbox(chatId, folder, 'GIT_CONFIG_GLOBAL=/dev/null git -c core.quotepath=off status --porcelain=v1 --untracked-files=all', [], undefined);
        if (r === null || r.exitCode !== 0 || r.timedOut) return null;
        const placeholders = new Set(SANDBOX_PLACEHOLDERS.map((p) => p.replace(/^\/|\/$/g, '').toLowerCase()));
        const lines = r.output
          .split(/\r?\n/)
          .filter((l) => /^[ MADRCU?!]{2} \S/.test(l))
          // Only an untracked entry can be a placeholder: a tracked .gitmodules that changed is real work.
          .filter((l) => !(l.startsWith('??') && placeholders.has((l.slice(3).replace(/^"|"$/g, '').split('/')[0] ?? '').toLowerCase())));
        const shown = lines.slice(0, UNCOMMITTED_LINES);
        const more = lines.length - shown.length;
        return { files: lines.length, summary: `${shown.join('\n')}${more > 0 ? `\n… and ${more} more` : ''}` };
      } catch {
        return null;
      }
    },

    async releaseSandbox(chatId) {
      await d.sandbox?.release(chatId);
    },
  };
}
