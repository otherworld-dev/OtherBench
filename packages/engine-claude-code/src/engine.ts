import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallback, McpServerConfig, Options, PostCompactHookInput, SDKMessage, SDKUserMessage, Settings, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { CLEAN_CHAT_AGENT_TOOLS, agentDisallowedTools } from '@otherbench/core/domain/agent-tools.js';
import { ARTIFACT_TOOL } from '@otherbench/core/domain/artifacts.js';
import { MAX_HISTORY_ATTACHMENT_BYTES } from '@otherbench/core/domain/attachment-binding.js';
import { CLEAR_ON_ITS_OWN, contextLineOf, isClearName, NOTHING_TO_COMPACT, type CommandRow } from '@otherbench/core/domain/context-lines.js';
import { RECALL_TOOL } from '@otherbench/core/domain/recall.js';
import { createPlanGate, PLAN_TOOL, runPlanCommand } from '@otherbench/core/domain/thread-tools.js';
import { toolContextFor } from '@otherbench/core/domain/tool-context.js';
import { listedName, MAX_REQUEST_ATTACHMENT_BYTES, MAX_REQUEST_ATTACHMENTS, OMISSION_REASONS, omissionNote, selectWithinBudget, withinAfterLoad, type Omission } from '@otherbench/core/domain/request-budget.js';
import { sniffToolImageMime } from '@otherbench/core/domain/tool-images.js';
import { HelperStopError, type ChatEngine, type ConnectionTestResult, type DiscoveredModel, type EngineBackgroundEvent, type EngineEvent, type EngineRequest, type SelfStart } from '@otherbench/core/ports/chat-engine.js';
import type { AskInput, ToolContext, ToolProvider, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { Connection, ResolvedProfile, ToolPolicy } from '@otherbench/core/types/config.js';
import type { CanonMessage, NoteAttachment, Part } from '@otherbench/core/types/messages.js';
import { isClaudeLogin, MAIN_ACCOUNT_SLUG, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import type { ResolvedFolder } from '@otherbench/core/types/workspace.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import { canUseToolFor, createGate, permissionDeniedHook, preToolUseHook, type Gate, type OtherBenchTool } from './approval.js';
import { otherBenchArtifactTool, otherBenchMcpServer, otherBenchPlanTool, otherBenchRecallTool, otherBenchServerName, otherBenchToolName, type OtherBenchServerTool } from './otherbench-server.js';
import { backendOf, buildChildEnv } from './env.js';
import { autoModeUnavailable, classifyClaudeCodeFailure, isMissingSessionError } from './errors.js';
import { SdkEventMapper } from './events.js';
import { HelperRegistry } from './helpers.js';
import { BackgroundTasks } from './background.js';
import { claudeSkillFolders } from './skill-folders.js';
import { renderHistory } from './history.js';
import { LivePool, LiveProcess, liveKey, NOTE_PICKED, PromptQueue, type NotePickedMessage, type OtherBenchServerSwitches, type TurnBinding, SELF_TURN_PREFIX } from './live.js';
import { chatCommands } from './commands.js';
import { toPlanUsage } from './plan-usage.js';
import { buildRelay, currentRelayed, relayServerTool, runRelayed, type Relay, type RelayedCall } from './relay.js';
import { pickSession, SessionClaims, type SessionPlan } from './session.js';
import { ApprovalTickets } from './tickets.js';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
  /** Drops one queued message by its uuid: true when it was still queued, false once started. Untyped in SDK 0.3.287. */
  cancelAsyncMessage?(uuid: string): Promise<boolean>;
  /** Stops one background task (a helper, a background command) by Claude Code's task id. */
  stopTask?(taskId: string): Promise<unknown>;
  /** Switches the running Claude Code's permission mode. */
  setPermissionMode?(mode: 'default' | 'auto'): Promise<unknown>;
  supportedModels(): Promise<{ value: string; displayName: string }[]>;
  accountInfo(): Promise<{ email?: string; subscriptionType?: string }>;
  /** The slash commands Claude Code offers in this session. Optional: an older Claude Code may not have it. */
  supportedCommands?(): Promise<SlashCommand[]>;
  /** The data behind /usage. Experimental in the SDK and may go away, hence optional; its answer is checked, not trusted (plan-usage.ts). */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
};

export interface ClaudeCodeEngineDeps {
  query: QueryFn;
  /** `askUser` answers Claude Code's AskUserQuestion and OtherBench's propose_plan through cards; without it both are refused. */
  approvals: Pick<ToolProvider, 'requestApproval' | 'recordAgentDenial'> & Partial<Pick<ToolProvider, 'askUser'>>;
  /**
   * A chat's settings as they are now (spec 2026-10-17-claude-background-helpers-design):
   * a background helper's call between replies is gated with these, not the
   * last reply's, so turning Auto off or plan mode on holds a running helper
   * too, and with the current policy of the profile the helper runs under.
   * Null when the chat or profile is gone, which refuses the call. Without it
   * the last reply's settings are used.
   */
  chatSettings?: (chatId: string, profileId: string) => { autoMode: boolean; planMode: boolean; policy: ToolPolicy } | null;
  /** Model listing for an endpoint backend (e.g. Ollama), supplied by the server. */
  listEndpointModels: (conn: Connection, token: string | null) => Promise<DiscoveredModel[]>;
  /** Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** How long a model-list / connection-test probe may take. Defaults to 20 s. */
  probeTimeoutMs?: number;
  /** How long an idle Claude Code process waits for the next message. Defaults to 30 minutes. */
  liveIdleMs?: number;
  /** How many idle Claude Code processes are kept. Defaults to 3. */
  maxLive?: number;
  /**
   * Runs an `artifact` tool call for a reply (Deck #896): the server's
   * executor. `mcpServerIds` are the profile's, so a live declaration (spec
   * 2026-10-12-live-artifacts) is checked against its tools. Without it,
   * Claude Code gets no artifact tool.
   */
  artifactTool?: (ctx: { chatId: string; messageId: string; mcpServerIds: string[] }, args: unknown) => Promise<unknown>;
  /** Runs a `recall` tool call for a reply (spec 2026-10-09-recall-design): the server's executor. Without it, Claude Code gets no recall tool. */
  recallTool?: (ctx: { chatId: string }, args: unknown) => Promise<unknown>;
  /**
   * Where a chat with no folder runs (a clean chat, spec
   * 2026-10-11-claude-code-clean-chat-and-mcp-design §1): each such chat gets
   * `<scratchRoot>/<chat id>`, the same folder every turn so its session
   * resumes. Without it, a private folder made in the system temp folder for
   * this engine (never a fixed path there, which another user could make first).
   */
  scratchRoot?: string;
  /**
   * What OtherBench relays to Claude Code through its own server for this policy,
   * as an API model gets it but ungated (OtherBenchToolProvider.relayTools): the
   * allowlisted MCP servers' tools (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §2),
   * the sandboxed run_command when the shell runs in the sandbox (spec
   * 2026-10-12-sandbox-design), and the browser when the profile turns it on
   * (spec 2026-10-12-model-browser-design §4). The gate approves each call
   * first, and a tool that describes its calls (the browser) runs only with
   * the arguments the gate approved. Without it, no relay.
   */
  relayTools?: (policy: ToolPolicy) => ToolSpec[] | Promise<ToolSpec[]>;
  /** Builds OtherBench's MCP server from its name and tools; defaults to the SDK's in-process server. Tests pass a fake. */
  mcpServer?: (name: string, tools: OtherBenchServerTool[]) => McpServerConfig;
}

const PROBE_TIMEOUT_MS = 20_000;

/** How long a stopped reply's turn may take to end after Claude Code is interrupted before its process is closed. */
export const INTERRUPT_GRACE_MS = 5_000;
/** How long a helper's call between replies, or a generation Claude Code didn't say whose it is, waits for this process's reader to learn which helper made it. */
const OWNER_WAIT_MS = 500;

/** A clean chat's folder name under the scratch root: its id, made a plain name so it can't point outside (the server deletes it by the same rule). */
export function scratchFolderName(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Deny rules for the claude-setup standard's secrets (core isSecretAgentPath),
 * on the SDK's flag-settings layer, so they hold whatever the project's own
 * settings say. OtherBench's gate refuses a file tool aimed at one, but a Grep
 * or Glob over a whole folder reads what it finds there: Claude Code turns
 * these rules into exclusions inside those tools. Unanchored patterns apply to
 * every search wherever it starts (the chat's folder, an extra folder, the
 * user's skills); a `//` one would only cover the current drive on Windows.
 */
export const SECRET_DENY_RULES: readonly string[] = ['Read', 'Edit'].flatMap((tool) =>
  ['**/.env', '**/.env.*', '**/.claude/certificates/**'].map((p) => `${tool}(${p})`)
);

/**
 * The flag-settings layer every turn's process gets (above user/project/local):
 * skills and slash commands may not run their inline !`cmd` shell, which would
 * run inside the 'internal' Skill tool and get no card (R14); and the secrets'
 * deny rules.
 */
const processSettings = (): Settings => ({ disableSkillShellExecution: true, permissions: { deny: [...SECRET_DENY_RULES] } });

/** A notice waiting for a safe moment to be yielded (see ClaudeCodeChatEngine.stream). */
type PendingNotice = { text: string | null };

type ContentBlock ={ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** The note Claude Code started reading, when `message` is the pump's NOTE_PICKED (live.ts); else null. */
function pickedNote(message: SDKMessage): string | null {
  const m = message as unknown as Partial<NotePickedMessage>;
  return m.type === NOTE_PICKED && typeof m.noteId === 'string' ? m.noteId : null;
}

/**
 * Whether a message read while no reply is attached begins a turn of the
 * main agent: Claude Code carrying on by itself. A helper's own messages
 * (with a parent tool call) and system messages don't.
 */
function startsOwnTurn(message: SDKMessage): boolean {
  const m = message as unknown as { type?: unknown; parent_tool_use_id?: unknown };
  return (m.type === 'stream_event' || m.type === 'assistant') && m.parent_tool_use_id === null;
}

/** A message to Claude Code; `uuid` lets the reply find the result of its own turn. */
const userMessage = (content: ContentBlock[], uuid?: string): SDKUserMessage =>
  ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' }, ...(uuid ? { uuid } : {}) }) as unknown as SDKUserMessage;

/** A one-message prompt stream that stays open until `close()` -- hooks and canUseTool travel over the same channel, so input must not end before the result. */
function promptStream(content: ContentBlock[]): { stream: AsyncIterable<SDKUserMessage>; close: () => void } {
  let close!: () => void;
  const closed = new Promise<void>((r) => (close = r));
  async function* gen(): AsyncGenerator<SDKUserMessage> {
    yield userMessage(content);
    await closed;
  }
  return { stream: gen(), close };
}

/**
 * Shared by utility calls and connection probes: no settings files, no MCP
 * servers (none passed, and strict so none are loaded from config), no
 * extended thinking, and no session written to disk.
 */
const lightweightOptions = (): Pick<Options, 'settingSources' | 'strictMcpConfig' | 'thinking' | 'persistSession'> => ({
  settingSources: [],
  strictMcpConfig: true,
  thinking: { type: 'disabled' },
  persistSession: false,
});

/** A message that starts with a slash command (`/name`, `/plugin:name args`): Claude Code runs it as that command. */
const COMMAND = /^\/([A-Za-z0-9][\w:.-]*)(\s|$)/;

/** What a reply that sent /compact has seen of it: the PostCompact hook's summary and the boundary's token counts. */
type Compaction = { summary: string | null; preTokens?: number; postTokens?: number | null; failure?: string };

const AUTO_COMPACTED = 'Claude Code compacted the context automatically.';

/** A reply's meta names the Claude account it ran on, only when that isn't main. */
function accountMeta(account: ClaudeAccountRef | undefined): { account?: string } {
  return account && account.slug !== MAIN_ACCOUNT_SLUG ? { account: account.slug } : {};
}

/** The account a request runs on: none for an endpoint backend, which uses no Claude login. */
function loginAccount(req: EngineRequest): ClaudeAccountRef | undefined {
  return req.profile.connection.baseUrl ? undefined : req.claudeAccount;
}

/** The focus of the /compact the new message is ('' for none), or null when it isn't one. */
function compactFocus(req: EngineRequest): string | null {
  const last = req.messages[req.messages.length - 1];
  const line = last ? contextLineOf(last) : null;
  return line?.kind === 'compact' ? (line.focus ?? '') : null;
}

/**
 * Whether the new message starts with Claude Code's own /clear (or /reset,
 * /new) in any case. It is never sent: OtherBench would still think the
 * session holds the whole chat. The turns route refuses it first; this is the backstop.
 */
function sendsClear(req: EngineRequest): boolean {
  const first = req.messages[req.messages.length - 1]?.parts.find((p) => p.type === 'text');
  const name = first?.type === 'text' ? COMMAND.exec(first.text)?.[1] : undefined;
  return name !== undefined && isClearName(name);
}

const textOf = (m: CanonMessage | undefined): string => (m?.parts ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');

/**
 * The names of the new message's non-image attachments, which Claude Code
 * turns do not receive, as they go into the transcript's notice and into the
 * prompt: each cleaned by core's `listedName` (one line, no control or hidden
 * character, at most 80 characters, no quote, no bracket that could close a
 * note, no comma that could pass for two names). A name with nothing left in
 * it is still listed, so the file is not dropped from the count.
 */
const skippedFiles = (m: CanonMessage | undefined): string[] => (m?.parts ?? []).flatMap((p) => (p.type === 'file' ? [listedName(p.filename) || 'unnamed file'] : []));

/** The transcript's line about the new message's images that were not sent (how many, and each reason once), or null when all were. */
function omittedImagesNotice(omitted: Omission[]): string | null {
  if (omitted.length === 0) return null;
  const reasons = [...new Set(omitted.map((why) => OMISSION_REASONS[why]))];
  return `Not sent to Claude Code: ${omitted.length} ${omitted.length === 1 ? 'image' : 'images'} (${reasons.join('; ')}).`;
}

/**
 * Runs OtherBench turns through the local Claude Code install via the Agent SDK
 * (spec: docs/superpowers/specs/2026-10-02-claude-code-engine-design.md).
 * Claude Code owns the agent loop and its tools; OtherBench owns permission
 * (every call goes through `approvals.requestApproval`) and the transcript.
 */
export class ClaudeCodeChatEngine implements ChatEngine {
  private readonly claims = new SessionClaims();
  /** Where clean chats run when `deps.scratchRoot` isn't given: made on first use (scratchFolder). */
  private privateScratch: string | undefined;
  /** Claude Code processes kept alive between replies, by session (see live.ts). */
  private readonly pool: LivePool;
  /** Every process started, so `dispose` can stop the busy ones too. */
  private readonly processes = new Set<LiveProcess>();
  /** Where work Claude Code does between replies is reported (spec 2026-10-17-claude-background-helpers-design). */
  private backgroundHandler: ((event: EngineBackgroundEvent) => void) | null = null;
  /** Each chat's last command list from a live process, so the menu has one while no process is running. */
  private readonly commandLists = new Map<string, CommandRow[]>();
  /** The replies running now (a user's or a self-started one), by message id: where a note sent to one goes. */
  private readonly running = new Map<string, { live: LiveProcess; req: EngineRequest }>();

  constructor(private readonly deps: ClaudeCodeEngineDeps) {
    this.pool = new LivePool(deps.liveIdleMs, deps.maxLive);
  }

  /** Stops every Claude Code process this engine started (server shutdown). */
  dispose(): void {
    this.pool.closeAll();
    for (const live of this.processes) live.close();
    this.processes.clear();
    this.commandLists.clear();
  }

  /**
   * The Claude Code commands a chat's slash menu offers. Only a live process is
   * asked: starting one just to list would run the folder's SessionStart hook.
   * With none, the chat's last list is returned (empty before its first reply).
   */
  async listCommands(input: { chatId: string; profile: ResolvedProfile; workspaceRoot: string | null }): Promise<CommandRow[]> {
    const live = [...this.processes].find((p) => !p.isClosed && p.last?.chatId === input.chatId && p.query.supportedCommands);
    if (live) {
      const rows = await this.rememberCommands(input.chatId, live);
      if (rows) return rows;
    }
    return this.commandLists.get(input.chatId) ?? [];
  }

  /** Asks a live process for its commands and remembers them; null when it can't answer. */
  private async rememberCommands(chatId: string, live: LiveProcess): Promise<CommandRow[] | null> {
    try {
      const rows = chatCommands((await live.query.supportedCommands?.()) ?? []);
      this.commandLists.set(chatId, rows);
      return rows;
    } catch {
      return null;
    }
  }

  onBackground(handler: (event: EngineBackgroundEvent) => void): void {
    this.backgroundHandler = handler;
  }

  async stopHelper(chatId: string, taskId: string): Promise<boolean> {
    for (const live of this.processes) {
      if (live.isClosed || live.background?.chatId !== chatId || !live.background.has(taskId)) continue;
      if (!live.query.stopTask) throw new HelperStopError("This version of Claude Code can't stop one background task. Update Claude Code to stop it from here.");
      await live.query.stopTask(taskId);
      return true;
    }
    return false;
  }

  /**
   * Pushes a note into the running reply's Claude Code with the note's id as
   * its uuid, so its command lifecycle says where it was read (live.ts).
   * False when the reply isn't running here, or this Claude Code doesn't
   * report a message's lifecycle.
   */
  async sendToReply(messageId: string, note: { id: string; text: string; attachments: NoteAttachment[] }): Promise<boolean> {
    const run = this.running.get(messageId);
    if (!run || run.live.isClosed || run.req.signal.aborted || !run.live.capabilities.includes('msg_lifecycle_v1')) return false;
    const content = await this.noteContent(run.req, note);
    // The reply may have ended while its images were read.
    if (this.running.get(messageId) !== run || run.live.isClosed || run.req.signal.aborted) return false;
    run.live.notes.set(note.id, messageId);
    run.live.input.push(userMessage(content, note.id));
    return true;
  }

  /** Takes back a note Claude Code hasn't started. False when no process holds it, it can't cancel one, or it had already started. */
  async withdrawNote(noteId: string): Promise<boolean> {
    const live = [...this.processes].find((p) => !p.isClosed && p.notes.has(noteId));
    return live ? this.cancelNote(live, noteId) : false;
  }

  /** Whether an open process still has note `noteId` (queued, starting or read): false means nothing here will ever report it. */
  knowsNote(noteId: string): boolean {
    return [...this.processes].some((p) => !p.isClosed && p.knows(noteId));
  }

  /**
   * Asks Claude Code to drop queued note `noteId`; forgotten once it
   * confirms. Its `cancelled` frame meanwhile isn't reported dropped: the
   * caller accounts for it.
   */
  private async cancelNote(live: LiveProcess, noteId: string): Promise<boolean> {
    if (!live.query.cancelAsyncMessage) return false;
    live.cancelling.add(noteId);
    try {
      const cancelled = await live.query.cancelAsyncMessage(noteId);
      if (cancelled) live.notes.delete(noteId);
      return cancelled;
    } finally {
      live.cancelling.delete(noteId);
    }
  }

  /**
   * A note as content blocks: its text, then its images. A file, or an image
   * over the per-file cap or whose bytes aren't an image, becomes a line in
   * the text instead: Claude Code turns only take images.
   */
  private async noteContent(req: EngineRequest, note: { text: string; attachments: NoteAttachment[] }): Promise<ContentBlock[]> {
    const lines = note.text ? [note.text] : [];
    const images: ContentBlock[] = [];
    const notSent = (a: NoteAttachment): void => {
      lines.push(`(${listedName(a.filename) || 'unnamed file'} wasn't sent: Claude Code only takes images.)`);
    };
    for (const a of note.attachments) {
      const size = req.attachmentSize?.(a.attachmentId);
      if (!a.mime.startsWith('image/') || !req.loadAttachment || (typeof size === 'number' && size > MAX_REQUEST_ATTACHMENT_BYTES)) {
        notSent(a);
        continue;
      }
      const bytes = await req.loadAttachment(a.attachmentId);
      const mediaType = bytes.length > MAX_REQUEST_ATTACHMENT_BYTES ? null : sniffToolImageMime(bytes);
      if (mediaType === null) notSent(a);
      else images.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
    }
    return [...(lines.length > 0 ? [{ type: 'text' as const, text: lines.join('\n') }] : []), ...images];
  }

  /**
   * Stops the turn on `live` for reply `messageId`: its own notes are
   * cancelled first, so none starts as the turn ends, then the turn is
   * interrupted. Not with interrupt's cancel_queued, which would also drop a
   * background helper's queued report.
   */
  private stopTurn(live: LiveProcess, messageId: string): void {
    this.cancelNotes(live, messageId);
    void live.query.interrupt().catch(() => live.close());
  }

  /**
   * Asks Claude Code to drop reply `messageId`'s unstarted notes, so none
   * runs after a reply that didn't finish. Each is forgotten once Claude Code
   * confirms; one it had already started (or can't cancel) stays tracked, so
   * the pump still routes its `started` frame.
   */
  private cancelNotes(live: LiveProcess, messageId: string): void {
    for (const [id, owner] of live.notes) {
      if (owner === messageId) void this.cancelNote(live, id).catch(() => undefined);
    }
  }

  /**
   * A chat's settings changed (any chat's, with no id): its running Claude
   * Code is switched to the chat's Auto setting at once, mid-reply too, as VS
   * Code switches modes. A scheduled run's process, and one not on the Claude
   * login, stay in default mode.
   */
  refreshChatSettings(chatId?: string): void {
    for (const live of this.processes) {
      const last = live.last;
      if (!last || live.isClosed || !live.canAuto || last.unattended || (chatId !== undefined && last.chatId !== chatId)) continue;
      const current = this.deps.chatSettings?.(last.chatId, last.profileId);
      if (!current) continue;
      const want = current.autoMode ? 'auto' : 'default';
      // Recorded first: Auto switched off holds at once, whatever becomes of the switch.
      live.wantsAuto = current.autoMode;
      if (live.permissionMode !== want) void live.switchMode(want);
    }
  }

  /** Closes the processes of the chats `gone` picks, ending their background tasks (a chat that was deleted keeps nothing running). */
  closeChats(gone: (chatId: string) => boolean): void {
    for (const live of [...this.processes]) {
      const chatId = live.background?.chatId ?? live.last?.chatId;
      if (chatId === undefined || !gone(chatId)) continue;
      live.close();
      this.processes.delete(live);
    }
  }

  /**
   * What Claude Code does while no reply is attached to the process. A turn
   * running notes Claude Code started is theirs (a follow-on, see
   * LiveProcess.takeStarting); any other is one it began by itself.
   */
  private handleIdle(live: LiveProcess, message: SDKMessage): void {
    if (!startsOwnTurn(message)) return;
    const notes = live.takeStarting(message);
    this.selfStart(live, message, notes.length > 0 ? notes : undefined);
  }

  /** Tells the server which notes a process never ran (it closed, or their turn ended at once), for its chat. Never throws: the process calls it unguarded. */
  private reportDropped(live: LiveProcess, dropped: string[]): void {
    try {
      const chatId = live.background?.chatId ?? live.last?.chatId;
      if (dropped.length === 0 || chatId === undefined) return;
      this.backgroundHandler?.({ type: 'notes-dropped', chatId, noteIds: dropped });
    } catch (err) {
      console.error('[engine-claude-code] could not report the notes a closed process never read:', err);
    }
  }

  /**
   * Claude Code began a turn by itself (a helper reported back), or ran notes
   * `noteIds` the user sent mid-reply after that reply ended (a follow-on): it's
   * handed to whoever runs replies as a self-start, its output buffered until
   * then. With nobody to run it, it's read to its end and dropped.
   */
  private selfStart(live: LiveProcess, first: SDKMessage, noteIds?: string[]): void {
    // A follow-on's result names its notes, so it's attached under the first; any other names no message of ours.
    const placeholder = noteIds?.[0] ?? `${SELF_TURN_PREFIX}${randomUUID()}`;
    const feed = live.attach(placeholder);
    feed.push(first);
    // Helper cards it starts belong to its reply, whose id comes when it runs.
    if (live.background) {
      live.background.current = placeholder;
      live.background.handle(first);
    }
    const iterator = feed[Symbol.asyncIterator]();
    let taken = false;
    // Nobody shows this turn: it's read to its end, and a note picked in it reported dropped.
    const drain = (): Promise<boolean> => this.readUnshown(live, iterator);
    const last = live.last;
    if (!last || !this.backgroundHandler) {
      void drain();
      return;
    }
    const start: SelfStart = {
      chatId: last.chatId,
      afterMessageId: last.messageId,
      profileId: last.profileId,
      // The user asked for a follow-on: it's attended, and needs no notice.
      ...(noteIds ? { notice: '', unattended: false, noteIds } : { notice: this.selfStartNotice(live), unattended: last.unattended }),
      run: (req) => {
        if (taken) throw new Error('A self-started turn runs once.');
        taken = true;
        live.background?.renameCurrent(placeholder, req.messageId);
        return this.runSelfStarted(live, req, iterator);
      },
      decline: () => {
        if (taken) return;
        taken = true;
        void drain();
      },
    };
    this.backgroundHandler({ type: 'self-start', start });
  }

  /** Why Claude Code carried on by itself: the helper or task that last finished, named once. */
  private selfStartNotice(live: LiveProcess): string {
    const finished = live.background?.lastFinished ?? null;
    // Named once: a later turn it starts with no helper finished since is not this helper's.
    if (live.background) live.background.lastFinished = null;
    return finished === null
      ? 'Carried on after a background task finished.'
      : finished.kind === 'local_agent'
        ? `Carried on after the helper "${finished.label}" reported back.`
        : `Carried on after the background task "${finished.label}" finished.`;
  }

  /** A self-started turn, for the reply `req` describes: gated and mapped like a user's reply, from the output already buffered. */
  private async *runSelfStarted(live: LiveProcess, req: EngineRequest, feed: AsyncIterator<SDKMessage>): AsyncGenerator<EngineEvent> {
    // The process's own backend and account: the chat may have moved to another account since it started.
    const { backend, account } = live;
    const clean = !req.workspaceRoot;
    const cwd = req.workspaceRoot ?? this.scratchFolder(req.chatId);
    // This process is already running the turn, and until `live.binding` is set its hooks refuse the
    // turn's calls ("No OtherBench reply is waiting"). So prepareReply's awaits (relayTools, and the media tools'
    // `limitsFor` under it) must stay store reads that settle at once: no network or disk I/O before the
    // binding is set. The binding is built by prepareReply itself, so it can't be set any sooner.
    const prepared = await this.prepareReply(req, backend, account, clean);
    prepared.proc.live = live;
    live.binding = prepared.binding;
    live.last = { chatId: req.chatId, messageId: req.messageId, profileId: req.profile.id, policy: req.profile.toolPolicy, ctx: prepared.gateCtx, autoMode: prepared.autoMode, unattended: req.unattended === true };
    const mapper = this.replyMapper(live, req, prepared.helpers, prepared.binding.results);
    this.running.set(req.messageId, { live, req });
    let stopped!: () => void;
    const stoppedNow = new Promise<{ stopped: true }>((resolve) => (stopped = () => resolve({ stopped: true })));
    const onAbort = (): void => {
      this.stopTurn(live, req.messageId);
      stopped();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) onAbort();
    let pending: Promise<IteratorResult<SDKMessage>> | null = null;
    let ended = false;
    // The turn ended in its own successful result: notes still queued then run as a follow-on.
    let finished = false;
    // A rejected rate limit seen in the turn: its failure says when the limit resets.
    let rateLimitResetsAt: number | null = null;
    // A usage limit was reported in the turn (a rejected rate-limit event, or Claude Code's own limit message), reset time known or not.
    let rateLimited = false;
    try {
      yield { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: live.sessionId ?? '', backend, ...accountMeta(account), cwd, tools: [], mcpServers: [] } };
      for (;;) {
        pending ??= feed.next();
        const next = await Promise.race([pending, stoppedNow]);
        if ('stopped' in next) {
          yield* mapper.backgroundOpen() as EngineEvent[];
          break;
        }
        pending = null;
        if (next.done) {
          // The process ended (closed, or died) before the turn's result: the reply didn't finish.
          if (!req.signal.aborted) {
            const text = [live.failure instanceof Error ? live.failure.message : 'Claude Code ended before it finished this reply.', ...live.stderr].join('\n');
            yield { type: 'error', error: classifyClaudeCodeFailure(text, { backend, modelId: req.profile.modelId, rateLimitResetsAt, rateLimited }) };
          }
          break;
        }
        const picked = pickedNote(next.value);
        if (picked !== null) {
          yield { type: 'note-picked', noteId: picked };
          continue;
        }
        if ((next.value as { type?: unknown }).type === 'result') ended = true;
        for (const event of mapper.map(next.value)) {
          if (event.type === 'init') continue;
          if (event.type === 'rate-limited') {
            rateLimitResetsAt = event.resetsAt;
            rateLimited = true;
            continue;
          }
          if (event.type === 'command-error') continue;
          if (event.type === 'compacted') {
            if (event.trigger === 'auto') yield { type: 'notice', text: AUTO_COMPACTED };
            continue;
          }
          if (event.type === 'result-error') {
            if (!req.signal.aborted) yield { type: 'error', error: classifyClaudeCodeFailure(event.text, { backend, modelId: req.profile.modelId, rateLimitResetsAt, rateLimited }) };
            continue;
          }
          if (event.type === 'finish') finished = true;
          yield event;
        }
        if (ended) break;
      }
    } finally {
      this.running.delete(req.messageId);
      prepared.tickets.clear();
      prepared.binding.results.clear();
      req.signal.removeEventListener('abort', onAbort);
      live.binding = null;
      if (!finished && !live.isClosed) this.cancelNotes(live, req.messageId);
      // Stopped mid-turn: read the rest in the background (the process stays pooled, as it already is).
      if (req.signal.aborted && !ended && !live.isClosed) void this.finishSelfStopped(live, feed, pending);
    }
  }

  /** After a self-started reply is stopped: reads its turn to the end; one that doesn't end in time closes the process. */
  private async finishSelfStopped(live: LiveProcess, feed: AsyncIterator<SDKMessage>, pending: Promise<IteratorResult<SDKMessage>> | null): Promise<void> {
    const timer = setTimeout(() => live.close(), INTERRUPT_GRACE_MS);
    timer.unref?.();
    try {
      await this.readUnshown(live, feed, pending);
    } catch {
      live.close();
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    if (req.purpose === 'utility') {
      yield* this.utility(req);
      return;
    }
    if (req.workspaceRoot && !existsSync(req.workspaceRoot)) {
      yield { type: 'error', error: { kind: 'unknown', retryable: false, message: `Workspace folder ${req.workspaceRoot} doesn't exist.` } };
      return;
    }
    // No folder: a clean chat, run in the chat's own empty scratch folder.
    const clean = !req.workspaceRoot;
    const cwd = req.workspaceRoot ?? this.scratchFolder(req.chatId);

    // Not yielded yet: an event yielded before the engine has done any real
    // work reaches TurnRunner before the turn's live stream is registered and
    // is dropped from SSE. runTurn yields it right after the init message
    // (or before an error if Claude Code fails before init).
    const skipped = skippedFiles(req.messages[req.messages.length - 1]);
    const notice: PendingNotice = { text: skipped.length > 0 ? `Not sent to Claude Code (only images are): ${skipped.join(', ')}.` : null };

    const conn = req.profile.connection;
    const backend = backendOf(conn, req.claudeAccount);
    const plan = pickSession({ history: req.messages, backend, cwd, latestMessageForSession: req.latestMessageForSession, claims: this.claims });
    try {
      // The new message's images are read once, before either attempt: a retry sends the same ones, and
      // what was left out is said once, in the same notice as the files.
      const images = await this.newImages(req);
      const leftOut = omittedImagesNotice(images.omitted);
      if (leftOut !== null) notice.text = notice.text === null ? leftOut : `${notice.text} ${leftOut}`;
      const first = yield* this.runTurn(req, plan, backend, notice, cwd, clean, images.blocks);
      // A stopped turn never starts a second Claude Code process.
      if (first === 'missing-session' && !req.signal.aborted) {
        // A /compact has nothing to compact in a new session: runTurn refuses it, without this notice.
        if (compactFocus(req) === null) yield { type: 'notice', text: "The earlier Claude Code session couldn't be found, so OtherBench started a new Claude Code session with this chat's history." };
        yield* this.runTurn(req, { mode: 'fresh' }, backend, notice, cwd, clean, images.blocks);
      }
    } finally {
      if (plan.mode === 'continue') this.claims.release(plan.sessionId);
    }
  }

  /**
   * One reply. It continues the session's live Claude Code process when one
   * is waiting with the same options (the planner already checked this
   * message answers the session's tip), else starts a process -- resuming
   * the session or fresh -- that stays alive afterwards for the next message.
   * Returns 'missing-session' (having yielded nothing) when a resume target
   * is gone. Yields `notice.text` once, after the init message or before an
   * error, and clears it.
   */
  private async *runTurn(
    req: EngineRequest,
    plan: SessionPlan,
    backend: string,
    notice: PendingNotice,
    cwd: string,
    clean: boolean,
    images: ContentBlock[]
  ): AsyncGenerator<EngineEvent, 'done' | 'missing-session'> {
    const profile = req.profile;
    // /compact compacts the session this chat continues; a new session has nothing to compact, so no process is started.
    const compacting = compactFocus(req) !== null;
    if (compacting && plan.mode !== 'continue') {
      yield { type: 'error', error: { kind: 'unknown', retryable: false, message: NOTHING_TO_COMPACT } };
      return 'done';
    }
    if (sendsClear(req)) {
      yield { type: 'error', error: { kind: 'unknown', retryable: false, message: CLEAR_ON_ITS_OWN } };
      return 'done';
    }
    const content = this.userContent(req, plan.mode === 'fresh', images);
    const account = loginAccount(req);
    const { gateCtx, autoMode, own, relay, tickets, helpers, binding, proc } = await this.prepareReply(req, backend, account, clean);
    const compaction: Compaction | null = compacting ? { summary: null } : null;
    if (compaction) binding.compacted = (summary) => (compaction.summary = summary);
    const options = this.processOptions(req, cwd, autoMode, clean);
    const key = liveKey(options, { backend, token: profile.apiKey, configDir: account?.configDir ?? null }, own);
    let taken = plan.mode === 'continue' ? await this.pool.takeWhenFree(plan.sessionId, key, req.signal) : null;
    // Stopped while waiting for the session's busy process (or before it began): no process is started.
    if (taken === null && req.signal.aborted) return 'done';
    // Auto changed since the process's last reply: it's switched, not replaced, so its helpers carry on.
    const mode = options.permissionMode === 'auto' ? 'auto' : 'default';
    if (taken && taken.permissionMode !== mode && !(await taken.switchMode(mode))) {
      taken.close();
      this.processes.delete(taken);
      taken = null;
    }
    const reused = taken !== null;
    const live = taken ?? this.startProcess(options, key, plan, own, relay, backend, account);
    live.wantsAuto = mode === 'auto';
    proc.live = live;
    // A reply stopped before it began starts no turn: a new process is closed, a pooled one goes back.
    if (req.signal.aborted) {
      if (reused) this.pool.release(live);
      else live.close();
      return 'done';
    }
    live.binding = binding;
    live.last = { chatId: req.chatId, messageId: req.messageId, profileId: profile.id, policy: profile.toolPolicy, ctx: gateCtx, autoMode, unattended: req.unattended === true };
    return yield* this.runReplyTurn(req, plan, backend, notice, cwd, live, reused, content, autoMode, helpers, tickets, binding.results, compaction);
  }

  /**
   * What a reply binds a process's hooks to: its gate (with its tool
   * context, policy and auto mode), its own tools and relay, and the switches
   * the process key needs. A user's reply and a self-started one build it the same way.
   */
  private async prepareReply(
    req: EngineRequest,
    backend: string,
    account: ClaudeAccountRef | undefined,
    clean: boolean
  ): Promise<{ gateCtx: ToolContext; autoMode: boolean; own: OtherBenchServerSwitches; relay: Relay; tickets: ApprovalTickets; helpers: HelperRegistry; binding: TurnBinding; proc: { live: LiveProcess | null } }> {
    const profile = req.profile;
    // Auto mode needs the Claude login; an endpoint backend always runs in
    // default mode (spec 2026-10-03-claude-code-auto-mode-design section 4).
    const autoMode = req.autoMode === true && isClaudeLogin(backend);
    // The reply's tool context: ids, folder (none for a clean chat, whose
    // scratch folder is not a workspace), extra folders, the plan gate and the
    // unattended flag.
    const gateCtx: ToolContext = toolContextFor(req);
    const approvals = this.deps.approvals;
    const askUser = approvals.askUser ? (ctx: ToolContext, input: AskInput) => approvals.askUser!(ctx, input) : undefined;
    // Artifacts (Deck #896) and recall (spec 2026-10-09-recall-design): a
    // process's OtherBench server has each tool or not from its start, so the
    // switches are part of the process key.
    const { artifactTool, recallTool } = this.deps;
    // The profile's MCP servers, the sandboxed run_command when its shell
    // runs in the sandbox, and the browser when it is on, relayed through the
    // same server (relay.ts). A clean chat has no folder for a command to run
    // in, so it gets no run_command; it does get the browser, which needs none.
    const relayed = this.deps.relayTools ? (await this.deps.relayTools(profile.toolPolicy)).filter((s) => !(clean && s.source === 'sandbox')) : [];
    const relay = buildRelay(relayed);
    const own: OtherBenchServerSwitches = {
      artifacts: artifactTool !== undefined && profile.toolPolicy.artifacts !== false,
      recall: recallTool !== undefined && profile.toolPolicy.recall !== false,
      plan: req.plan !== undefined && askUser !== undefined,
      relay: relay.hash,
    };
    const tickets = new ApprovalTickets();
    const results = new Map<string, unknown>();
    // The helpers this reply's agent starts: the mapper records them, the gate names them on approval cards.
    const helpers = new HelperRegistry();
    // The process this reply runs in, once chosen. Its calls go to the
    // classifier while that Claude Code is in auto mode, which can change
    // mid-reply (Auto switched, refreshChatSettings); a scheduled run never.
    const proc: { live: LiveProcess | null } = { live: null };
    const classifier = isClaudeLogin(backend) && req.unattended !== true;
    const binding: TurnBinding = {
      gate: createGate({
        approvals: this.deps.approvals,
        policy: profile.toolPolicy,
        ctx: gateCtx,
        readFolders: this.skillFolders(req.workspaceRoot, account),
        autoMode: () => classifier && proc.live?.wantsAuto === true && proc.live.permissionMode === 'auto',
        helpers,
        // A call the reply's own registry can't name: its process's background tasks may (an earlier reply's helper, or this one's not read yet).
        backgroundOwner: async (toolUseId, wait) => {
          const background = proc.live?.background;
          if (!background) return null;
          return wait ? background.whenOwned(toolUseId, OWNER_WAIT_MS) : background.ownerOf(toolUseId);
        },
        onApproved: (spec, input, args, toolUseId) => tickets.add(spec.name, input, args, toolUseId),
      }),
      // Auto can be switched on mid-reply, so the classifier's blocks are audited whenever it could run.
      ...(isClaudeLogin(backend) ? { permissionDenied: permissionDeniedHook({ approvals: this.deps.approvals, ctx: gateCtx }) } : {}),
      ...(artifactTool && own.artifacts ? { artifact: (args: unknown) => artifactTool({ chatId: req.chatId, messageId: req.messageId, mcpServerIds: profile.toolPolicy.mcpServerIds }, args) } : {}),
      ...(recallTool && own.recall ? { recall: (args: unknown) => recallTool({ chatId: req.chatId }, args) } : {}),
      ...(own.plan && askUser ? { plan: (args: unknown) => runPlanCommand(askUser, gateCtx, args) } : {}),
      // The current reply's spec for that tool, not the one the process started
      // with (an edit to the sandbox allowlist or the browser's blocked sites
      // applies without a new process), and only if it is the kind of tool the
      // gate approved: see currentRelayed, which fails closed (the browser
      // branch's `?? spec` fallback to the old spec is not kept). A tool that
      // describes its calls then runs only with its approval ticket: runRelayed.
      // A generator's result is kept by its tool-use id for the reply's mapper.
      ...(relay.tools.size > 0
        ? {
            relay: async (approved: ToolSpec, args: unknown, call?: RelayedCall) => {
              const spec = currentRelayed(relay, approved);
              return runRelayed(spec, args, gateCtx, tickets, call, spec.source === 'media' ? (id, output) => results.set(id, output) : undefined);
            },
          }
        : {}),
      tickets,
      results,
    };
    return { gateCtx, autoMode, own, relay, tickets, helpers, binding, proc };
  }

  /**
   * The mapper for one reply on `live`: this process's own tools under the API engines' names, helper cards
   * noted for its background tasks, and a generator's result as its relayed call returned it (`results`).
   */
  private replyMapper(live: LiveProcess, req: EngineRequest, helpers: HelperRegistry, results: Map<string, unknown>): SdkEventMapper {
    const renames = new Map<string, string>();
    if (live.artifactTool) renames.set(live.artifactTool, ARTIFACT_TOOL);
    if (live.recallTool) renames.set(live.recallTool, RECALL_TOOL);
    if (live.planTool) renames.set(live.planTool, PLAN_TOOL);
    for (const [claudeName, apiName] of live.relayNames) renames.set(claudeName, apiName);
    const relayedResult = (id: string): unknown => {
      const held = results.get(id);
      results.delete(id);
      return held;
    };
    return new SdkEventMapper({ ...(renames.size > 0 ? { renames } : {}), helpers, relayedResult, profileId: req.profile.id, modelId: req.profile.modelId });
  }

  /** A user's reply on `live`: sends its message and reads its turn (see runTurn). */
  private async *runReplyTurn(
    req: EngineRequest,
    plan: SessionPlan,
    backend: string,
    notice: PendingNotice,
    cwd: string,
    live: LiveProcess,
    reused: boolean,
    content: ContentBlock[],
    autoMode: boolean,
    helpers: HelperRegistry,
    tickets: ApprovalTickets,
    results: Map<string, unknown>,
    compaction: Compaction | null
  ): AsyncGenerator<EngineEvent, 'done' | 'missing-session'> {
    const flushNotice = function* (): Generator<EngineEvent> {
      const text = notice.text;
      if (text === null) return;
      notice.text = null;
      yield { type: 'notice', text };
    };
    const profile = req.profile;
    // The process's background tasks, for this chat; this reply's own helper cards are left to its mapper.
    live.background ??= new BackgroundTasks(req.chatId, (event) => this.backgroundHandler?.(event));
    live.background.current = req.messageId;
    live.onIdle = (message) => this.handleIdle(live, message);
    live.onClosed = (dropped) => this.reportDropped(live, dropped);
    live.onDropped = (dropped) => this.reportDropped(live, dropped);
    // This reply's turn, up to its own result: attached before the message
    // goes, so nothing of it is missed and nothing else reaches it.
    const uuid = randomUUID();
    const feed = live.attach(uuid)[Symbol.asyncIterator]();

    // Stopping a reply interrupts Claude Code's turn and keeps the process, so
    // its background helpers carry on and the next message continues the
    // session. The reply ends at once; the turn is read to its end in the
    // background (finishStopped), and one that doesn't end in time closes the process.
    let stopped!: () => void;
    const stoppedNow = new Promise<{ stopped: true }>((resolve) => (stopped = () => resolve({ stopped: true })));
    const onAbort = (): void => {
      this.stopTurn(live, req.messageId);
      stopped();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    live.input.push(userMessage(content, uuid));
    this.running.set(req.messageId, { live, req });

    const mapper = this.replyMapper(live, req, helpers, results);
    let sawInit = false;
    let finished = false;
    // The turn's own result arrived (a success or not): the process is in a known state.
    let ended = false;
    let rateLimitResetsAt: number | null = null;
    // A usage limit was reported in the turn (a rejected rate-limit event, or Claude Code's own limit message), reset time known or not.
    let rateLimited = false;
    let pending: Promise<IteratorResult<SDKMessage>> | null = null;
    try {
      while (!finished) {
        pending ??= feed.next();
        const next = await Promise.race([pending, stoppedNow]);
        if ('stopped' in next) {
          // Its helpers working in the background carry on: their cards say so rather than stopped.
          yield* mapper.backgroundOpen() as EngineEvent[];
          break;
        }
        pending = null;
        if (next.done) {
          // The output ended (the process died) unless this turn's result was the last thing.
          if (live.failure !== null && !ended) throw live.failure;
          break;
        }
        const picked = pickedNote(next.value);
        if (picked !== null) {
          yield { type: 'note-picked', noteId: picked };
          continue;
        }
        if ((next.value as { type?: unknown }).type === 'result') ended = true;
        for (const event of mapper.map(next.value)) {
          if (event.type === 'init') {
            live.sessionId = event.sessionId;
            // Claude Code repeats its init mid-turn after compacting, on the same session: only the
            // turn's first starts it. A later one can say another mode (Auto switched off since),
            // which isn't auto mode being unavailable.
            if (sawInit) continue;
            sawInit = true;
            if (autoMode && event.permissionMode !== 'auto') {
              // Claude Code started in another mode: auto mode isn't available
              // for this account or model. Stop before the model does any work,
              // and persist no session meta for this half-started session.
              live.close();
              yield* flushNotice();
              yield { type: 'error', error: autoModeUnavailable() };
              return 'done';
            }
            yield { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: event.sessionId, backend, ...accountMeta(loginAccount(req)), cwd, tools: event.tools, mcpServers: event.mcpServers } };
            yield* flushNotice();
          } else if (event.type === 'rate-limited') {
            rateLimitResetsAt = event.resetsAt;
            rateLimited = true;
          } else if (event.type === 'compacted') {
            if (event.trigger === 'auto') yield { type: 'notice', text: AUTO_COMPACTED };
            else if (compaction) Object.assign(compaction, { preTokens: event.preTokens, postTokens: event.postTokens });
          } else if (event.type === 'command-error') {
            // Why a /compact failed, in Claude Code's words; another command's is left out, as before.
            if (compaction) compaction.failure = event.text;
          } else if (event.type === 'result-error') {
            // A stopped reply's interrupted turn: its process carries on for the next message.
            if (req.signal.aborted) return 'done';
            live.close();
            if (!sawInit && !reused && plan.mode !== 'fresh' && isMissingSessionError(event.text)) return 'missing-session';
            yield* flushNotice();
            yield { type: 'error', error: classifyClaudeCodeFailure(event.text, { backend, modelId: profile.modelId, rateLimitResetsAt, rateLimited, autoMode }) };
            return 'done';
          } else {
            if (event.type === 'finish') {
              finished = true;
              if (compaction) {
                // The turn ended without the hook's summary: there is nothing to cut the chat at, so the
                // reply fails, with Claude Code's own reason when it gave one.
                if (compaction.summary === null) {
                  yield { type: 'error', error: { kind: 'unknown', retryable: false, message: compaction.failure ?? 'Claude Code finished without compacting.' } };
                  continue;
                }
                yield {
                  type: 'context-summary',
                  text: compaction.summary,
                  ...(compaction.preTokens !== undefined ? { preTokens: compaction.preTokens } : {}),
                  ...(typeof compaction.postTokens === 'number' ? { postTokens: compaction.postTokens } : {}),
                };
              }
            }
            yield event;
          }
        }
      }
      if (!finished) yield* flushNotice(); // a stream that ended without a result
    } catch (err) {
      live.close();
      if (req.signal.aborted) return 'done'; // TurnRunner marks the message cancelled
      const text = [err instanceof Error ? err.message : String(err), ...live.stderr].join('\n');
      if (!sawInit && !reused && plan.mode !== 'fresh' && isMissingSessionError(text)) return 'missing-session';
      yield* flushNotice();
      yield { type: 'error', error: classifyClaudeCodeFailure(text, { backend, modelId: profile.modelId, rateLimitResetsAt, rateLimited, autoMode }) };
    } finally {
      this.running.delete(req.messageId);
      tickets.clear();
      results.clear();
      req.signal.removeEventListener('abort', onAbort);
      if (req.signal.aborted && !ended && !live.isClosed) {
        // Stopped mid-turn: the process goes back to the pool at once, so the
        // session's next message waits for this turn to end in it (its feed is
        // still attached) rather than starting a second process on the
        // session. The turn is read to its end in the background.
        this.pool.release(live);
        void this.finishStopped(live, feed, pending);
      } else if (ended && !live.isClosed && (finished || req.signal.aborted)) {
        // A turn that reached its own result leaves its process waiting for the next message.
        this.pool.release(live);
        void this.rememberCommands(req.chatId, live);
      } else {
        live.close();
      }
      // A reply that didn't finish cleanly leaves no note to run after it (a closed process takes them with it).
      if (!finished && !live.isClosed) this.cancelNotes(live, req.messageId);
      if (live.isClosed) this.processes.delete(live);
    }
    return 'done';
  }

  /**
   * Reads the rest of a turn nobody shows (a declined self-start, a stopped
   * reply's): a note picked in it is reported dropped, since no reply will
   * fold it. True when the turn's result came.
   */
  private async readUnshown(live: LiveProcess, feed: AsyncIterator<SDKMessage>, pending: Promise<IteratorResult<SDKMessage>> | null = null): Promise<boolean> {
    let ended = false;
    for (let next = await (pending ?? feed.next()); !next.done; next = await feed.next()) {
      const picked = pickedNote(next.value);
      if (picked !== null) this.reportDropped(live, [picked]);
      else if ((next.value as { type?: unknown }).type === 'result') ended = true;
    }
    return ended;
  }

  /**
   * After a stop: reads the interrupted turn to its result (the process is
   * already pooled). One whose turn hasn't ended within INTERRUPT_GRACE_MS is
   * closed.
   */
  private async finishStopped(live: LiveProcess, feed: AsyncIterator<SDKMessage>, pending: Promise<IteratorResult<SDKMessage>> | null): Promise<void> {
    const timer = setTimeout(() => live.close(), INTERRUPT_GRACE_MS);
    timer.unref?.();
    let ended = false;
    try {
      ended = await this.readUnshown(live, feed, pending);
    } catch {
      ended = false;
    } finally {
      clearTimeout(timer);
      if (!ended) live.close();
      if (live.isClosed) this.processes.delete(live);
    }
  }

  /**
   * The user's own skills and plugins, read-only, for the gate alone (skill-folders.ts):
   * a skill may read its own files with Claude Code's file tools. Not part of the
   * reply's tool context, so the sandboxed shell and relayed tools never get them.
   */
  private skillFolders(workspaceRoot: string | null, account: ClaudeAccountRef | undefined): ResolvedFolder[] {
    if (!workspaceRoot) return [];
    const base = this.deps.baseEnv ?? process.env;
    // Another account's skills are in its own config folder; main reads the inherited one as before.
    return claudeSkillFolders(account?.configDir ? { ...base, CLAUDE_CONFIG_DIR: account.configDir } : base, workspaceRoot);
  }

  /** A clean chat's own folder, created if need be. A chat id that isn't a plain name is made into one, so it can't point outside. */
  private scratchFolder(chatId: string): string {
    this.privateScratch ??= this.deps.scratchRoot ?? mkdtempSync(join(tmpdir(), 'otherbench-claude-scratch-'));
    const folder = join(this.privateScratch, scratchFolderName(chatId));
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  /** The options a Claude Code process is started with, minus what each process wires up itself (startProcess). */
  private processOptions(req: EngineRequest, cwd: string, autoMode: boolean, clean: boolean): Options {
    const profile = req.profile;
    if (clean) {
      // A clean chat (spec 2026-10-11-claude-code-clean-chat-and-mcp-design
      // §1): none of the user's Claude Code settings, CLAUDE.md, skills, hooks
      // or MCP config, no coding-agent prompt, and of the built-in tools only
      // web search and fetch, the checklist and questions. Its MCP tools are OtherBench's own server's.
      return {
        cwd,
        model: profile.modelId,
        env: buildChildEnv(this.deps.baseEnv ?? process.env, profile.connection, profile.apiKey, profile.modelId, req.claudeAccount),
        permissionMode: autoMode ? 'auto' : 'default',
        includePartialMessages: true,
        settingSources: [],
        strictMcpConfig: true,
        settings: processSettings(),
        // Web search and fetch, plus the checklist and questions (spec 2026-10-12-thread-cards-design section 6).
        tools: [...(profile.toolPolicy.agentWeb === false ? [] : ['WebSearch', 'WebFetch']), ...CLEAN_CHAT_AGENT_TOOLS],
        disallowedTools: agentDisallowedTools(profile.toolPolicy),
        ...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
        ...(profile.params.thinkingBudgetTokens ? { thinking: { type: 'enabled', budgetTokens: profile.params.thinkingBudgetTokens } } : {}),
        ...(req.effort ? { effort: req.effort } : {}),
      };
    }
    return {
      cwd,
      model: profile.modelId,
      env: buildChildEnv(this.deps.baseEnv ?? process.env, profile.connection, profile.apiKey, profile.modelId, req.claudeAccount),
      permissionMode: autoMode ? 'auto' : 'default',
      includePartialMessages: true,
      // The folder's own settings; the user's (their CLAUDE.md, skills, plugins, hooks and MCP servers)
      // only when the profile asks, since they cost about 17K tokens a session (test/fixtures/README.md).
      settingSources: profile.toolPolicy.agentUserSettings === true ? ['user', 'project', 'local'] : ['project', 'local'],
      // Flag-settings layer: no skill inline shell (R14), and the secrets' deny rules.
      settings: processSettings(),
      disallowedTools: agentDisallowedTools(profile.toolPolicy),
      systemPrompt: profile.systemPrompt ? { type: 'preset', preset: 'claude_code', append: profile.systemPrompt } : { type: 'preset', preset: 'claude_code' },
      // MCP off: load no MCP config but the servers passed here (only OtherBench's
      // own, for artifacts and recall), so the model isn't offered the user's MCP tools
      // and none of their servers start. The gate still denies MCP calls.
      ...(profile.toolPolicy.agentMcp === false ? { strictMcpConfig: true } : {}),
      ...(profile.params.thinkingBudgetTokens ? { thinking: { type: 'enabled', budgetTokens: profile.params.thinkingBudgetTokens } } : {}),
      // The chat's effort (chosen in the chat window) over the user's Claude Code settings; unset leaves those to decide.
      ...(req.effort ? { effort: req.effort } : {}),
      // The chat's extra folders are deliberately NOT additionalDirectories:
      // Claude Code would load the skills and commands under each one's
      // .claude. It reaches them anyway when the gate allows a call (live
      // probe, test/fixtures/README.md), and the system prompt names them.
    };
  }

  /**
   * Starts a Claude Code process whose input stays open for later messages.
   * Its hooks are fixed now, so they call through `live.binding`: whichever
   * reply is running decides its tool calls, and with none running every
   * call is refused.
   */
  private startProcess(options: Options, key: string, plan: SessionPlan, own: OtherBenchServerSwitches, relay: Relay, backend: string, account: ClaudeAccountRef | undefined): LiveProcess {
    // Auto mode needs a Claude login; an endpoint backend never runs in it.
    const canAuto = isClaudeLogin(backend);
    this.pool.makeRoom();
    const input = new PromptQueue();
    const abortController = new AbortController();
    let live: LiveProcess | null = null;
    // OtherBench's own MCP server (Deck #896), under a name made for this process.
    // The gate passes its artifact and recall tools without a card, matching
    // those exact names, so no project MCP config can name a server to get
    // the same pass.
    const server = own.artifacts || own.recall || own.plan || relay.tools.size > 0 ? otherBenchServerName() : null;
    const ownArtifactTool = server && own.artifacts ? otherBenchToolName(server, ARTIFACT_TOOL) : null;
    const ownRecallTool = server && own.recall ? otherBenchToolName(server, RECALL_TOOL) : null;
    const ownPlanTool = server && own.plan ? otherBenchToolName(server, PLAN_TOOL) : null;
    // A relayed tool is matched by its exact name on this process's server, like artifact and recall.
    const relayed = new Map<string, ToolSpec>(server ? [...relay.tools].map(([name, spec]) => [otherBenchToolName(server, name), spec] as const) : []);
    const ownTool = (toolName: string): OtherBenchTool | { relay: ToolSpec } | undefined => {
      if (toolName === ownArtifactTool) return 'artifact';
      if (toolName === ownRecallTool) return 'recall';
      if (toolName === ownPlanTool) return 'plan';
      const spec = relayed.get(toolName);
      return spec ? { relay: spec } : undefined;
    };
    const tools: OtherBenchServerTool[] = [
      ...(own.artifacts ? [otherBenchArtifactTool(() => live?.binding?.artifact)] : []),
      ...(own.recall ? [otherBenchRecallTool(() => live?.binding?.recall)] : []),
      ...(own.plan ? [otherBenchPlanTool(() => live?.binding?.plan)] : []),
      ...[...relay.tools].map(([name, spec]) => relayServerTool(name, spec, () => live?.binding?.relay)),
    ];
    /**
     * Between replies only a background helper's own call can be approved, on
     * its helper's card (the reply that started it), with the chat's settings
     * as they are now. The last reply's signal is dead by then (TurnRunner
     * aborts it when a reply ends), so the call is tied to the process's own.
     */
    const helperContext = async (toolUseId: string | undefined): Promise<{ ctx: ToolContext; policy: ToolPolicy; autoMode: boolean } | null> => {
      const owner = live?.last && toolUseId ? await live.background?.whenOwned(toolUseId, OWNER_WAIT_MS) : null;
      if (!live?.last || !owner) return null;
      const last = live.last;
      const current = this.deps.chatSettings ? this.deps.chatSettings(last.chatId, last.profileId) : { autoMode: last.autoMode, planMode: last.ctx.plan !== undefined, policy: last.policy };
      if (!current) return null;
      const { plan: lastPlan, ...rest } = last.ctx;
      const plan = current.planMode ? (lastPlan ?? createPlanGate()) : undefined;
      return {
        ctx: { ...rest, ...(plan ? { plan } : {}), signal: abortController.signal, messageId: owner.messageId, shownSubagent: { callId: owner.callId, label: owner.label, parentProfileId: last.profileId } },
        policy: current.policy,
        // Claude Code's own mode can't change mid-process: Auto turned on since doesn't make it auto.
        autoMode: current.autoMode && !last.unattended && live.permissionMode === 'auto',
      };
    };
    const gate: Gate = async (toolName, toolInput, signal, opts) => {
      const which = ownTool(toolName);
      if (live?.binding) return live.binding.gate(toolName, toolInput, signal, { ...opts, ...(which ? { own: which } : {}) });
      const helper = which ? null : await helperContext(opts?.toolUseId);
      // A reply may have begun while this waited: its gate decides.
      if (live?.binding) return live.binding.gate(toolName, toolInput, signal, opts);
      if (!helper) return { allow: false, reason: 'No OtherBench reply is waiting on this tool call.' };
      return createGate({ approvals: this.deps.approvals, readFolders: this.skillFolders(helper.ctx.workspaceRoot, account), ...helper })(toolName, toolInput, signal, opts);
    };
    const permissionDenied: HookCallback = async (hookInput, toolUseId, hookOptions) => {
      if (live?.binding) return live.binding.permissionDenied ? live.binding.permissionDenied(hookInput, toolUseId, hookOptions) : {};
      // A helper's call the classifier blocked between replies is audited against its helper's reply, like any other.
      const helper = await helperContext(toolUseId ?? undefined);
      return helper ? permissionDeniedHook({ approvals: this.deps.approvals, ctx: helper.ctx })(hookInput, toolUseId, hookOptions) : {};
    };
    // A /compact's summary, for the reply that sent it. Claude Code compacting by itself is told by its boundary instead.
    const postCompact: HookCallback = async (hookInput) => {
      const input = hookInput as PostCompactHookInput;
      if (input.trigger === 'manual' && typeof input.compact_summary === 'string' && input.compact_summary.trim()) live?.binding?.compacted?.(input.compact_summary);
      return {};
    };
    const full: Options = {
      ...options,
      // Its tool acts for whichever reply is running, like the hooks.
      ...(server ? { mcpServers: { ...(options.mcpServers ?? {}), [server]: (this.deps.mcpServer ?? otherBenchMcpServer)(server, tools) } } : {}),
      abortController,
      stderr: (data: string) => {
        if (!live) return;
        live.stderr.push(data);
        if (live.stderr.length > 50) live.stderr.shift();
      },
      // The hook waits on a human; Claude Code's default hook timeout (60 s)
      // would cancel the call under an open card. 86400 s = one day.
      hooks: {
        PreToolUse: [{ hooks: [preToolUseHook(gate)], timeout: 86_400 }],
        // Classifier blocks are audited as deny:auto (auto mode only).
        // On the Claude login whatever mode it starts in: Auto can be switched on while it runs.
        ...(canAuto ? { PermissionDenied: [{ hooks: [permissionDenied] }] } : {}),
        PostCompact: [{ hooks: [postCompact] }],
      },
      canUseTool: canUseToolFor(gate),
      ...(plan.mode === 'continue' ? { resume: plan.sessionId } : {}),
    };
    const process = new LiveProcess(key, input, abortController, this.deps.query({ prompt: input, options: full }));
    process.permissionMode = options.permissionMode ?? 'default';
    process.canAuto = canAuto;
    process.backend = backend;
    process.account = account;
    process.artifactTool = ownArtifactTool;
    process.recallTool = ownRecallTool;
    process.planTool = ownPlanTool;
    for (const [claudeName, spec] of relayed) process.relayNames.set(claudeName, spec.name);
    live = process;
    for (const p of this.processes) if (p.isClosed) this.processes.delete(p);
    this.processes.add(process);
    return process;
  }

  /**
   * The new message's images, when the model takes them, as what goes to
   * Claude Code in their place: an image block, or the note for one left out
   * (the notes the API engine writes), in the order of the parts. They are
   * picked from the references and the sizes their rows state before any is
   * read (the same selector the API engine uses): the newest few, each within
   * the upload cap and all together within the request's room, each file once;
   * the type sent is the one the bytes have. Nothing is left out silently:
   * `omitted` says why for each, for the transcript's notice.
   */
  private async newImages(req: EngineRequest): Promise<{ blocks: ContentBlock[]; omitted: Omission[] }> {
    const last = req.messages[req.messages.length - 1];
    const blocks: ContentBlock[] = [];
    const omitted: Omission[] = [];
    const images = (last?.parts ?? []).filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image');
    if (images.length === 0 || !req.loadAttachment || !(req.profile.model?.supportsVision ?? true)) return { blocks, omitted };
    const leaveOut = (why: Omission): void => {
      omitted.push(why);
      blocks.push({ type: 'text', text: omissionNote(why) });
    };
    const distinct = [...new Map(images.map((p) => [p.attachmentId, p])).values()];
    const limits = { maxCount: MAX_REQUEST_ATTACHMENTS, maxEach: MAX_HISTORY_ATTACHMENT_BYTES, maxTotal: MAX_REQUEST_ATTACHMENT_BYTES };
    const newestFirst = [...distinct].reverse().map((p) => ({ key: p.attachmentId, size: req.attachmentSize ? req.attachmentSize(p.attachmentId) : undefined }));
    const verdicts = selectWithinBudget(newestFirst, limits);
    const loaded = { bytes: 0 };
    for (const part of distinct) {
      const verdict = verdicts.get(part.attachmentId) ?? 'unknown';
      if (verdict !== 'load') {
        leaveOut(verdict);
        continue;
      }
      const bytes = await req.loadAttachment(part.attachmentId);
      if (!withinAfterLoad(bytes.length, loaded, limits)) {
        leaveOut(bytes.length > limits.maxEach ? 'too-large' : 'over-budget');
        continue;
      }
      const mediaType = sniffToolImageMime(bytes);
      if (mediaType === null) leaveOut('not-image');
      else blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } });
    }
    return { blocks, omitted };
  }

  /**
   * The new user message as content blocks: seeded history for a fresh
   * session, text, then its images (see `newImages`). A /compact is the
   * command alone. A message starting with any other slash command sends only
   * that first text part (later ones, such as the artifacts note, would become
   * its arguments), with a fresh session's history after it: the command still
   * runs and the model sees the history (live probe, test/fixtures/README.md).
   */
  private userContent(req: EngineRequest, fresh: boolean, images: ContentBlock[]): ContentBlock[] {
    const focus = compactFocus(req);
    if (focus !== null) return [{ type: 'text', text: focus ? `/compact ${focus}` : '/compact' }];
    const last = req.messages[req.messages.length - 1];
    const history = fresh ? renderHistory(req.messages) : '';
    const first = last?.parts.find((p) => p.type === 'text');
    if (first?.type === 'text' && COMMAND.test(first.text)) return [{ type: 'text', text: history ? `${first.text}\n\n${history}` : first.text }, ...images];
    const skipped = skippedFiles(last);
    const note = skipped.length > 0 ? `\n\n(Attached files not sent, because Claude Code turns in OtherBench only receive images: ${skipped.join(', ')}.)` : '';
    const text = [history, textOf(last)].filter((s) => s.length > 0).join('\n\n') + note;
    return [{ type: 'text', text }, ...images];
  }

  /**
   * Tool-less side calls (auto-title): one turn, no settings, no MCP servers,
   * no thinking, nothing persisted (spec §4). Kept as light as possible so a
   * title comes back quickly.
   */
  private async *utility(req: EngineRequest): AsyncGenerator<EngineEvent> {
    const conn = req.profile.connection;
    const backend = backendOf(conn, req.claudeAccount);
    const prompt = promptStream([{ type: 'text', text: textOf(req.messages[req.messages.length - 1]) }]);
    const abortController = new AbortController();
    const onAbort = (): void => abortController.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    if (req.signal.aborted) abortController.abort();
    const model = isClaudeLogin(backend) ? 'haiku' : req.profile.modelId;
    const mapper = new SdkEventMapper();
    try {
      for await (const msg of this.deps.query({
        prompt: prompt.stream,
        options: {
          ...lightweightOptions(),
          cwd: tmpdir(),
          model,
          env: buildChildEnv(this.deps.baseEnv ?? process.env, conn, req.profile.apiKey, model, req.claudeAccount),
          maxTurns: 1,
          tools: [],
          systemPrompt: 'Reply with only the requested text.',
          permissionMode: 'default',
          includePartialMessages: true,
          abortController,
        },
      })) {
        for (const event of mapper.map(msg)) {
          if (event.type === 'text-delta' || event.type === 'finish') yield event;
          if (event.type === 'finish') prompt.close();
          if (event.type === 'result-error') { prompt.close(); yield { type: 'error', error: classifyClaudeCodeFailure(event.text, { backend, modelId: model }) }; return; }
        }
      }
    } catch (err) {
      if (!req.signal.aborted) yield { type: 'error', error: classifyClaudeCodeFailure(err instanceof Error ? err.message : String(err), { backend, modelId: model }) };
    } finally {
      prompt.close();
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  async listModels(conn: Connection, apiKey: string | null): Promise<DiscoveredModel[]> {
    if (conn.baseUrl) return this.deps.listEndpointModels(conn, apiKey);
    const models = await this.probe(conn, (q) => q.supportedModels());
    return models.map((m) => ({ modelId: m.value, displayName: m.displayName, contextWindow: null, supportsVision: true, supportsTools: true }));
  }

  async testConnection(conn: Connection, apiKey: string | null): Promise<ConnectionTestResult> {
    const start = Date.now();
    try {
      if (conn.baseUrl) {
        const models = await this.deps.listEndpointModels(conn, apiKey);
        return { ok: true, message: `Connected; ${models.length} model(s) available.`, latencyMs: Date.now() - start };
      }
      const account = await this.probe(conn, (q) => q.accountInfo());
      const who = account.email ?? 'your Claude account';
      return { ok: true, message: `Logged in as ${who}${account.subscriptionType ? ` (${account.subscriptionType})` : ''}.`, latencyMs: Date.now() - start };
    } catch (err) {
      const error = classifyClaudeCodeFailure(err instanceof Error ? err.message : String(err), { backend: backendOf(conn), modelId: '' });
      return { ok: false, message: error.message, latencyMs: Date.now() - start };
    }
  }

  /**
   * A Claude login's plan usage (Deck #825), read through the SDK's
   * experimental /usage call with the transcript scan skipped: main's, or
   * `account`'s in its own config folder. Null for an endpoint backend (no
   * plan) or an SDK without the call.
   */
  async planUsage(conn: Connection, account?: ClaudeAccountRef): Promise<PlanUsage | null> {
    if (conn.baseUrl) return null;
    const answer = await this.probe(
      conn,
      async (q) => (typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function' ? q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) : null),
      account
    );
    return toPlanUsage(answer, Date.now());
  }

  /**
   * Starts Claude Code without sending a prompt, asks it something, then shuts
   * it down. Bounded by a timeout so a wedged process can't hang a model list
   * or connection test forever.
   */
  private async probe<T>(conn: Connection, ask: (q: ReturnType<QueryFn>) => Promise<T>, account?: ClaudeAccountRef): Promise<T> {
    const abortController = new AbortController();
    const idle: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    const timeoutMs = this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new Error(`Claude Code didn't respond within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
    });
    try {
      const q = this.deps.query({ prompt: idle, options: { ...lightweightOptions(), env: buildChildEnv(this.deps.baseEnv ?? process.env, conn, null, 'haiku', account), abortController } });
      return await Promise.race([ask(q), timedOut]);
    } finally {
      clearTimeout(timer);
      abortController.abort();
    }
  }
}
