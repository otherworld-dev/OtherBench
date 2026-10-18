import { create } from 'zustand';
import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import type { BackgroundHelper, BackgroundMark, ChatLevelEvent } from '@otherbench/core/types/background.js';
import { chatsWorkingElsewhere } from './peerActivity.js';
import type { ScheduleTarget } from '@otherbench/core/domain/schedule.js';
import type { TurnEvent } from '@otherbench/core/domain/turn.js';
import type { Chat, Project } from '@otherbench/core/ports/store.js';
import type { Connection, ModelInfo, Profile } from '@otherbench/core/types/config.js';
import type { CanonMessage, MessageStatus } from '@otherbench/core/types/messages.js';
import type { NoteOutcome, ReplyNote } from '@otherbench/core/types/notes.js';
import { CLIENT_ID } from '../lib/clientId.js';
import type { AppEvent, AppEventsHello, PendingApprovalSummary } from '@otherbench/core/types/events.js';
import type { RecordedUsage } from '@otherbench/core/types/usage.js';
import {
  closeTab as closePaneTab,
  focusPane as focusPaneIn,
  forgetChat,
  forgetProject,
  loadPaneState,
  moveTab as movePaneTab,
  openTab as openPaneTab,
  savePaneState,
  setLayout as setPaneLayout,
  setSplitSizes as setPaneSplitSizes,
  showChat,
  toggleMaximised as togglePaneMaximised,
  type Layout,
  type PaneState,
} from './panes.js';
import { applyEventToMessage, applyHelloBuffer, emptyExtras, replayEvents, type MessageExtras } from './reducer.js';
import type { PeersOverview } from './api.js';

/** One entry of an SSE `hello` reply's `inFlight` array (routes/turns.ts). */
export interface HelloBuffer {
  messageId: string;
  status: MessageStatus;
  events: TurnEvent[];
}

export type StreamConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

/**
 * What the project page shows (spec 2026-10-08-project-page-design §3).
 * `returnFocus` is a selector to focus on close when whatever opened the page
 * is gone by then (a menu item).
 */
export type ProjectPageState = { mode: 'create'; parentId?: string; returnFocus?: string } | { mode: 'edit'; projectId: string; returnFocus?: string };

/** The Scheduled overlay; `prefill` opens the editor for a new schedule on that chat or project. */
export type SchedulesPageState = { prefill?: ScheduleTarget };

/** A note on its way back to the box; `takenBack` when the user took it back, rather than it not being sent. */
export type ReturnedNote = ReplyNote & { takenBack?: true };

export interface OtherBenchState {
  // --- reference data (connections/models/profiles CRUD) -------------------
  connections: Connection[];
  models: ModelInfo[];
  profiles: Profile[];
  setConnections(connections: Connection[]): void;
  setModels(models: ModelInfo[]): void;
  setProfiles(profiles: Profile[]): void;
  /** Inserts or replaces one connection by id -- lets the Settings UI reflect a create/patch/test result immediately, without a full list refetch. */
  upsertConnection(connection: Connection): void;
  /**
   * Removes a connection AND every model/profile/chat that referenced it
   * (transitively, for chats: connection -> profile -> chat), mirroring the
   * database's own `ON DELETE CASCADE` (see migrations/001-initial.ts) so
   * local state doesn't keep showing rows the server just cascaded away.
   * Also clears `activeChatId` when the active chat was one of them --
   * otherwise the thread pane and Inspector would go on treating a chat the
   * server just deleted as still selected (dead composer, Inspector polling
   * `/grants` and `/audit` for an id that now 404s forever). See
   * `removeProfile` below for the identical one-hop version of this.
   */
  removeConnection(id: string): void;
  /** Inserts or replaces one model by id (also used to fold in freshly `discoverModels`-ed rows). */
  upsertModel(model: ModelInfo): void;
  upsertModels(models: ModelInfo[]): void;
  /** Inserts or replaces one profile by id. */
  upsertProfile(profile: Profile): void;
  /** Removes a profile AND every chat built on it, clearing `activeChatId` if the active chat was one of them -- see `removeConnection`'s doc, which shares this exact cascade for the one-more-hop connection -> profile -> chat case. */
  removeProfile(id: string): void;

  // --- chats -----------------------------------------------------------------
  chats: Chat[];
  activeChatId: string | null;
  setChats(chats: Chat[]): void;
  upsertChat(chat: Chat): void;
  removeChat(chatId: string): void;
  setActiveChatId(chatId: string | null): void;
  /** Tabs, layout and the chat in each pane (#824). The focused pane's chat is always `activeChatId`. */
  paneState: PaneState;
  /** Adds the chat as a tab (once) and shows it in the focused pane. */
  openTab(chatId: string): void;
  /** Removes the tab only; a pane showing the chat keeps it. */
  closeTab(chatId: string): void;
  moveTab(chatId: string, beforeId: string | null): void;
  setLayout(layout: Layout): void;
  focusPane(index: number): void;
  /** Remembers a dragged divider's sizes (`splitKey`). */
  setSplitSizes(key: string, sizes: number[]): void;
  /** Maximises the focused pane, or puts it back. */
  toggleMaximised(): void;
  /** Local-only optimistic (or server-confirmed) head move -- see api.turns.setHead. */
  setHeadMessageId(chatId: string, messageId: string): void;
  /** The quick-chat hotkey and whether registering it worked (desktop only; Task 37). Null until tried. */
  hotkeyStatus: { accelerator: string; error: string | null } | null;
  setHotkeyStatus(status: { accelerator: string; error: string | null }): void;
  /** Tool calls waiting for approval anywhere in the app, by request id, from `GET /api/events` (Task 34). */
  appPendingApprovals: Record<string, PendingApprovalSummary>;
  /** Replies being written anywhere in the app: chat id by message id (#824). */
  appRunningTurns: Record<string, string>;
  /** Chats controlling this computer (computer use), by chat id, with their last action (`actionSummary`: never typed text). */
  computerSessions: Record<string, { lastAction?: string }>;
  /** Chats with background tasks running anywhere in the app, by chat id, with how many. */
  appBackgroundChats: Record<string, number>;
  /** Bumped each time another machine's changes are applied here: open chats reload their messages. */
  syncRevision: number;
  /**
   * Per chat, bumped when a turn starts or finishes there that this window
   * didn't start and hasn't loaded (sent from another window, or from the
   * other machine): an open chat reloads its messages (useChatSync).
   */
  chatReloads: Record<string, number>;
  /** This machine and its paired ones, with reachability (state/machines.ts); null until loaded. */
  machines: PeersOverview | null;
  setMachines(machines: PeersOverview | null): void;
  /** The events stream's `hello`: replaces the pending approvals and running replies with the server's lists. */
  applyAppHello(hello: AppEventsHello): void;
  /** One app-wide event: keeps chats and the pending approvals current. */
  applyAppEvent(event: AppEvent): void;
  /** Mirrors the server recording a keep on a compare variant (POST .../head) -- see `CanonMessage.keptAt`. */
  markKept(messageId: string, at: number): void;

  // --- projects ---------------------------------------------------------------
  projects: Project[];
  /** The project list has arrived from the server: until then a missing project may just not be loaded yet. */
  projectsLoaded: boolean;
  setProjects(projects: Project[]): void;
  /** Inserts or replaces one project by id. */
  upsertProject(project: Project): void;
  /**
   * Removes a project and, in the SAME update, moves its chats to no project
   * (`projectId: null`) -- mirroring chat.project_id's ON DELETE SET NULL, the
   * same "never show what the server no longer has" invariant as
   * removeConnection. Chats are never removed.
   */
  removeProject(id: string): void;

  // --- messages + the SSE reconciliation seam --------------------------------
  /** Every message the client has learned about, across whatever chat(s) have been loaded or streamed into, keyed by id. */
  messages: Record<string, CanonMessage>;
  /** Per-message accrual that isn't part of `CanonMessage` (currently: usage, from `finish` events). */
  extras: Record<string, MessageExtras>;
  /**
   * `TurnEvent`s tagged with a message id this client doesn't know about
   * yet. Never dropped -- see `applyTurnEvent`'s doc.
   */
  pendingEvents: Record<string, TurnEvent[]>;
  streamStatus: StreamConnectionStatus;
  setStreamStatus(status: StreamConnectionStatus): void;

  /**
   * Bulk-hydrates a chat's whole message tree from `GET /chats/:id/messages`.
   * Authoritative (replaces, never merges), except for a reply still being
   * written, whose stream knows more than its stored checkpoint.
   */
  loadMessages(chatId: string, messages: CanonMessage[], headMessageId: string | null, usage?: Record<string, RecordedUsage>): void;
  /** Recorded usage of finished replies, by message id, as the server stored it (#819). */
  recordedUsage: Record<string, RecordedUsage>;

  /**
   * Registers a message the client has just learned the id (and shell) of
   * -- from a turn-creation response, or a bulk hydrate for one message at
   * a time. A no-op if the id is already known, so a redundant/late
   * registration can never clobber further-along live-streamed state with
   * a stale shell. Flushes and clears any events that arrived early for
   * this id (see `applyTurnEvent`) by replaying them onto the shell.
   */
  registerMessage(message: CanonMessage): void;

  /**
   * Applies one live `TurnEvent` from the open SSE connection. If the
   * message is already known, folds the event in directly. If not --
   * a real race in this design, since the SSE channel can already be
   * delivering events for a message before the `POST .../turns` response
   * that introduces its id has even resolved client-side -- the event is
   * buffered in `pendingEvents` rather than dropped, to be replayed by
   * `registerMessage` once the id becomes known.
   */
  applyTurnEvent(event: TurnEvent): void;
  /** Removes an approval prompt locally (the server says the request no longer exists), wherever it is showing. */
  dropApproval(requestId: string): void;
  /** Drops a question or plan card the server no longer knows (a 404 on answering). */
  dropAsk(askId: string): void;

  /**
   * Reconciles an SSE `hello` reply (sent on connect and on every
   * reconnect) against local state. Each buffer's `events` is "everything
   * for this message since the turn started" (StreamRegistry's contract),
   * so a known message's content is fully rebuilt from that list rather
   * than appended to -- this is what makes replaying the same hello twice,
   * or reconnecting after already having received some of these events
   * live, produce identical (not duplicated) text. An unknown message's
   * pending buffer is likewise replaced wholesale, not appended to, since
   * the hello buffer already subsumes anything buffered so far.
   */
  applyHello(buffers: HelloBuffer[]): void;

  // --- background work (spec 2026-10-17-claude-background-helpers-design) ---
  /** Each chat's background tasks (Claude Code helpers, background commands), as its stream last said. */
  chatHelpers: Record<string, BackgroundHelper[]>;
  /** Approval cards a chat's background helpers asked for while no reply was streaming. */
  backgroundApprovals: Record<string, ApprovalRequest[]>;
  /** The chat stream's hello: what's background for the chat, besides its replies in flight. */
  setChatBackground(chatId: string, helpers: BackgroundHelper[], approvals: ApprovalRequest[]): void;

  // --- messages sent while a reply runs (spec 2026-10-18-send-while-replying-design) ---
  /** Each chat's notes still waiting for its replies to end, as its stream last said. */
  chatNotes: Record<string, ReplyNote[]>;
  /** The notes this tab sent that haven't been resolved yet, by id. Kept in sessionStorage, so a reload of the tab keeps them. */
  sentNotes: Record<string, ReplyNote>;
  /** Notes handed back to this tab's composer (a stopped or lost reply, or one taken back), not yet taken. */
  returnedNotes: ReturnedNote[];
  /**
   * This tab's notes the stream said were resolved before their send returned
   * (the server can resolve one before it answers). Each is consumed by its
   * `noteSent`, which every send reaches, so the set stays small.
   */
  earlyResolved: Record<string, true>;
  /** This tab sent a note: remember it until it resolves (unless it already has). */
  noteSent(note: ReplyNote): void;
  /** A waiting note was taken back from this tab: forget it as sent, and hand it to the composer. */
  noteTakenBack(note: ReplyNote): void;
  /** The chat's returned notes, removed from the store: the composer puts them back in the box. */
  takeReturnedNotes(chatId: string): ReturnedNote[];
  /**
   * The chat stream's hello. A note this tab sent that the server no longer
   * holds goes back to the composer if it was `returned` or the server has no
   * word of it (lost with a reply). One that was delivered (`folded`/`turn`)
   * or taken back (`removed`, the withdrawing tab already restored it) is
   * simply forgotten.
   */
  setChatNotes(chatId: string, notes: ReplyNote[], outcomes: { noteId: string; outcome: NoteOutcome }[]): void;
  /**
   * One event from a chat's stream: its background tasks, a reload when its
   * stored messages changed, an approval card for a reply that isn't streaming
   * (a background helper's, kept for the strip), or a reply's own event.
   */
  applyChatEvent(chatId: string, event: (TurnEvent & Partial<BackgroundMark>) | ChatLevelEvent): void;

  /**
   * Optimistically resets a message right before a retry request goes out
   * (task 27: per-tab Retry on a failed compare variant) -- clears its
   * parts/error, sets status back to 'streaming', and drops any accrued
   * usage extras. Mirrors what `TurnRunner.retry` does server-side to the
   * same message id: without this, deltas from the retried attempt would
   * append onto the failed attempt's stale parts (and its error would keep
   * showing) instead of starting clean, since `applyEventToMessage`'s
   * text-delta case always appends onto whatever is already there. A no-op
   * if the message isn't known locally.
   */
  resetMessageForRetry(messageId: string): void;

  // --- UI ---------------------------------------------------------------------
  inspectorCollapsed: boolean;
  setInspectorCollapsed(collapsed: boolean): void;
  /** Narrow layout only: whether the inspector overlay is open. Never remembered; it starts closed. */
  inspectorOverlayOpen: boolean;
  setInspectorOverlayOpen(open: boolean): void;
  /** The open project page, or null. Opened from the sidebar, a project's menu or the Inspector; App renders it. */
  projectPage: ProjectPageState | null;
  openProjectPage(page: ProjectPageState): void;
  closeProjectPage(): void;
  /** The open Scheduled overlay, or null. App renders it. */
  schedulesPage: SchedulesPageState | null;
  openSchedules(prefill?: ScheduleTarget): void;
  closeSchedules(): void;
  /** Bumped by every schedule event, so the overlay re-reads the list. */
  schedulesVersion: number;
}

/**
 * `projects` with every default profile in `profileIds` cleared, mirroring
 * the server (project.default_profile_id is ON DELETE SET NULL, and archiving
 * a profile clears it too). Returns the same array when nothing changes.
 */
function clearDefaultProfiles(projects: Project[], profileIds: ReadonlySet<string>): Project[] {
  const hit = (p: Project): boolean => p.defaultProfileId !== null && profileIds.has(p.defaultProfileId);
  if (!projects.some(hit)) return projects;
  return projects.map((p) => (hit(p) ? { ...p, defaultProfileId: null } : p));
}

/**
 * The pane state with the focused pane holding `activeChatId`, which is the
 * source of truth for the active chat (tests and callers may set it directly).
 */
function synced(state: { paneState: PaneState; activeChatId: string | null }): PaneState {
  const { paneState, activeChatId } = state;
  if (paneState.panes[paneState.focusedPane] === activeChatId) return paneState;
  const panes = [...paneState.panes];
  panes[paneState.focusedPane] = activeChatId;
  return { ...paneState, panes };
}

/** A pane-state change, with `activeChatId` following the focused pane. */
function withPanes(next: PaneState): { paneState: PaneState; activeChatId: string | null } {
  return { paneState: next, activeChatId: next.panes[next.focusedPane] ?? null };
}

const initialPanes = loadPaneState();

/** localStorage key: whether the docked inspector is collapsed. Per device. */
export const INSPECTOR_COLLAPSED_STORAGE_KEY = 'otherbench.inspectorCollapsed';

export function loadInspectorCollapsed(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveInspectorCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(INSPECTOR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // storage blocked or full -- the choice still applies for this session.
  }
}

/** sessionStorage key: the notes this tab sent that aren't resolved yet. Per tab, so a reload keeps them. */
export const SENT_NOTES_STORAGE_KEY = 'otherbench.sentNotes';

function loadSentNotes(): Record<string, ReplyNote> {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(SENT_NOTES_STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const notes: Record<string, ReplyNote> = {};
    for (const [id, n] of Object.entries(parsed as Record<string, Partial<ReplyNote> | null>)) {
      if (n && n.id === id && typeof n.chatId === 'string' && typeof n.text === 'string' && Array.isArray(n.attachments)) notes[id] = n as ReplyNote;
    }
    return notes;
  } catch {
    return {};
  }
}

function saveSentNotes(notes: Record<string, ReplyNote>): void {
  try {
    window.sessionStorage.setItem(SENT_NOTES_STORAGE_KEY, JSON.stringify(notes));
  } catch {
    // storage blocked or full -- they're still held for this load.
  }
}

/**
 * Note ids the chat's loaded replies show as `user-note` parts, and those in
 * reply events waiting for their message: Claude read those notes.
 */
function readNoteIds(state: Pick<OtherBenchState, 'messages' | 'pendingEvents'>, chatId: string): Set<string> {
  const ids = new Set<string>();
  for (const m of Object.values(state.messages)) {
    if (m.chatId !== chatId) continue;
    for (const p of m.parts) if (p.type === 'user-note') ids.add(p.noteId);
  }
  for (const events of Object.values(state.pendingEvents)) {
    for (const e of events) if (e.type === 'user-note') ids.add(e.part.noteId);
  }
  return ids;
}

function bump(counts: Record<string, number>, chatId: string): Record<string, number> {
  return { ...counts, [chatId]: (counts[chatId] ?? 0) + 1 };
}

/** A computer session as the banner keeps it: a last action only when it is text. */
function computerSessionOf(lastAction: unknown): { lastAction?: string } {
  return typeof lastAction === 'string' ? { lastAction } : {};
}

export const useOtherBenchStore = create<OtherBenchState>()((set, get) => ({
  connections: [],
  models: [],
  profiles: [],
  setConnections: (connections) => set({ connections }),
  setModels: (models) => set({ models }),
  setProfiles: (profiles) => set({ profiles }),
  upsertConnection: (connection) =>
    set((state) => {
      const idx = state.connections.findIndex((c) => c.id === connection.id);
      if (idx === -1) return { connections: [...state.connections, connection] };
      const next = [...state.connections];
      next[idx] = connection;
      return { connections: next };
    }),
  removeConnection: (id) =>
    set((state) => {
      // INVARIANT: what counts as "still my chat" is decided by whether the
      // server would still hand it back, never by what this store already
      // happened to have rendered. A chat whose profile (and so whose
      // connection) no longer exists is not "unchanged" merely because
      // nothing has told this store otherwise yet -- it must be dropped in
      // the SAME update as its profile, not left for a future refetch to
      // notice.
      const removedProfileIds = new Set(state.profiles.filter((p) => p.connectionId === id).map((p) => p.id));
      const chats = state.chats.filter((c) => !removedProfileIds.has(c.profileId));
      const activeChatId = chats.some((c) => c.id === state.activeChatId) ? state.activeChatId : null;
      return {
        connections: state.connections.filter((c) => c.id !== id),
        models: state.models.filter((m) => m.connectionId !== id),
        profiles: state.profiles.filter((p) => p.connectionId !== id),
        chats,
        projects: clearDefaultProfiles(state.projects, removedProfileIds),
        activeChatId,
      };
    }),
  upsertModel: (model) =>
    set((state) => {
      const idx = state.models.findIndex((m) => m.id === model.id);
      if (idx === -1) return { models: [...state.models, model] };
      const next = [...state.models];
      next[idx] = model;
      return { models: next };
    }),
  upsertModels: (models) =>
    set((state) => {
      const next = [...state.models];
      for (const model of models) {
        const idx = next.findIndex((m) => m.id === model.id);
        if (idx === -1) next.push(model);
        else next[idx] = model;
      }
      return { models: next };
    }),
  upsertProfile: (profile) =>
    set((state) => {
      const idx = state.profiles.findIndex((p) => p.id === profile.id);
      const profiles = idx === -1 ? [...state.profiles, profile] : state.profiles.map((p, i) => (i === idx ? profile : p));
      // An archived profile stops being any project's default (routes/profiles.ts does the same).
      const projects = profile.archivedAt === null ? state.projects : clearDefaultProfiles(state.projects, new Set([profile.id]));
      return { profiles, projects };
    }),
  removeProfile: (id) =>
    set((state) => {
      // Same invariant as removeConnection above, one hop shorter.
      const chats = state.chats.filter((c) => c.profileId !== id);
      const activeChatId = chats.some((c) => c.id === state.activeChatId) ? state.activeChatId : null;
      return {
        profiles: state.profiles.filter((p) => p.id !== id),
        chats,
        activeChatId,
        projects: clearDefaultProfiles(state.projects, new Set([id])),
      };
    }),

  chats: [],
  activeChatId: initialPanes.panes[initialPanes.focusedPane] ?? null,
  paneState: initialPanes,
  openTab: (chatId) => set((state) => withPanes(openPaneTab(synced(state), chatId))),
  // A closed viewer tab can hand its pane back to its chat, so the active chat follows the pane.
  closeTab: (chatId) => set((state) => withPanes(closePaneTab(synced(state), chatId))),
  moveTab: (chatId, beforeId) => set((state) => ({ paneState: movePaneTab(synced(state), chatId, beforeId) })),
  setLayout: (layout) => set((state) => withPanes(setPaneLayout(synced(state), layout))),
  focusPane: (index) => set((state) => withPanes(focusPaneIn(synced(state), index))),
  setSplitSizes: (key, sizes) => set((state) => ({ paneState: setPaneSplitSizes(state.paneState, key, sizes) })),
  toggleMaximised: () => set((state) => ({ paneState: togglePaneMaximised(state.paneState) })),
  setChats: (chats) => set({ chats }),
  upsertChat: (chat) =>
    set((state) => {
      const idx = state.chats.findIndex((c) => c.id === chat.id);
      if (idx === -1) return { chats: [...state.chats, chat] };
      const next = [...state.chats];
      next[idx] = chat;
      return { chats: next };
    }),
  removeChat: (chatId) => set((state) => ({ chats: state.chats.filter((c) => c.id !== chatId), ...withPanes(forgetChat(synced(state), chatId)) })),
  // Fills the focused pane, or focuses the pane already showing the chat.
  setActiveChatId: (chatId) => set((state) => withPanes(showChat(synced(state), chatId))),
  setHeadMessageId: (chatId, messageId) =>
    set((state) => ({
      chats: state.chats.map((c) => (c.id === chatId ? { ...c, headMessageId: messageId } : c)),
    })),
  hotkeyStatus: null,
  setHotkeyStatus: (status) => set({ hotkeyStatus: status }),
  appPendingApprovals: {},
  appRunningTurns: {},
  computerSessions: {},
  appBackgroundChats: {},
  syncRevision: 0,
  chatReloads: {},
  machines: null,
  setMachines: (machines) =>
    set((state) => {
      // A chat a paired machine has just started a reply in reloads, so the reply (fetched from that machine) shows live.
      const before = chatsWorkingElsewhere(state.machines);
      const started = [...chatsWorkingElsewhere(machines)].filter((id) => !before.has(id));
      if (started.length === 0) return { machines };
      const chatReloads = { ...state.chatReloads };
      for (const id of started) chatReloads[id] = (chatReloads[id] ?? 0) + 1;
      return { machines, chatReloads };
    }),
  applyAppHello: (hello) =>
    set({
      appPendingApprovals: Object.fromEntries(hello.pendingApprovals.map((p) => [p.requestId, p])),
      appRunningTurns: Object.fromEntries((hello.runningTurns ?? []).map((t) => [t.messageId, t.chatId])),
      computerSessions: Object.fromEntries((hello.computerSessions ?? []).map((c) => [c.chatId, computerSessionOf(c.lastAction)])),
      appBackgroundChats: Object.fromEntries((hello.backgroundChats ?? []).filter((c) => c.count > 0).map((c) => [c.chatId, c.count])),
    }),
  applyAppEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case 'chat-created':
        case 'chat-updated': {
          const idx = state.chats.findIndex((c) => c.id === event.chat.id);
          if (idx === -1) return { chats: [...state.chats, event.chat] };
          const chats = [...state.chats];
          chats[idx] = event.chat;
          return { chats };
        }
        case 'chat-deleted':
          return { chats: state.chats.filter((c) => c.id !== event.chatId), ...withPanes(forgetChat(synced(state), event.chatId)) };
        case 'approval-requested': {
          const { chatId, messageId, requestId, toolName, kind } = event;
          return { appPendingApprovals: { ...state.appPendingApprovals, [requestId]: { chatId, messageId, requestId, toolName, ...(kind ? { kind } : {}) } } };
        }
        case 'approval-resolved': {
          if (!(event.requestId in state.appPendingApprovals)) return state;
          const next = { ...state.appPendingApprovals };
          delete next[event.requestId];
          return { appPendingApprovals: next };
        }
        case 'turn-started': {
          const running = { ...state.appRunningTurns };
          for (const id of event.messageIds) running[id] = event.chatId;
          // Replies this window knows nothing of: show them by reloading the chat.
          // A turn with none (a /clear) has only the line, which a paired machine may not have synced yet.
          const unknown = event.messageIds.length === 0 || event.messageIds.some((id) => !state.messages[id]);
          return { appRunningTurns: running, ...(unknown ? { chatReloads: bump(state.chatReloads, event.chatId) } : {}) };
        }
        case 'turn-finished': {
          // Approvals end with their turn.
          const entries = Object.entries(state.appPendingApprovals);
          const kept = entries.filter(([, p]) => p.messageId !== event.messageId);
          const running = { ...state.appRunningTurns };
          delete running[event.messageId];
          // A reply this window hasn't seen finish (or at all): reload the chat for its final state.
          const known = state.messages[event.messageId];
          const stale = !known || known.status === 'streaming';
          return {
            appRunningTurns: running,
            ...(kept.length === entries.length ? {} : { appPendingApprovals: Object.fromEntries(kept) }),
            ...(stale ? { chatReloads: bump(state.chatReloads, event.chatId) } : {}),
          };
        }
        case 'sync-applied':
          return { syncRevision: state.syncRevision + 1 };
        case 'schedules-changed':
        case 'schedule-run-started':
        case 'schedule-run-finished':
          return { schedulesVersion: state.schedulesVersion + 1 };
        case 'computer-session': {
          const next = { ...state.computerSessions };
          if (event.active) {
            // An event with no last action (the session started, say) keeps the one already shown.
            next[event.chatId] = typeof event.lastAction === 'string' ? computerSessionOf(event.lastAction) : (next[event.chatId] ?? {});
          } else {
            delete next[event.chatId];
          }
          return { computerSessions: next };
        }
        case 'background-tasks': {
          const next = { ...state.appBackgroundChats };
          if (event.count > 0) next[event.chatId] = event.count;
          else delete next[event.chatId];
          return { appBackgroundChats: next };
        }
        default:
          return state;
      }
    }),
  markKept: (messageId, at) =>
    set((state) => {
      const message = state.messages[messageId];
      if (!message) return state;
      return { messages: { ...state.messages, [messageId]: { ...message, keptAt: at } } };
    }),

  projects: [],
  projectsLoaded: false,
  setProjects: (projects) =>
    set((state) => {
      // A project deleted elsewhere (another tab or machine) arrives as a list without it: its page closes too.
      const kept = new Set(projects.map((p) => p.id));
      const paneState = state.projects.filter((p) => !kept.has(p.id)).reduce((panes, p) => forgetProject(panes, p.id), synced(state));
      return { projects, projectsLoaded: true, ...withPanes(paneState) };
    }),
  upsertProject: (project) =>
    set((state) => {
      const idx = state.projects.findIndex((p) => p.id === project.id);
      if (idx === -1) return { projects: [...state.projects, project] };
      const next = [...state.projects];
      next[idx] = project;
      return { projects: next };
    }),
  removeProject: (id) =>
    set((state) => ({
      // Its sub-projects become top level, as on the server.
      projects: state.projects.filter((p) => p.id !== id).map((p) => (p.parentId === id ? { ...p, parentId: null } : p)),
      chats: state.chats.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)),
      ...withPanes(forgetProject(synced(state), id)),
    })),

  messages: {},
  extras: {},
  pendingEvents: {},
  streamStatus: 'idle',
  setStreamStatus: (status) => set({ streamStatus: status }),

  recordedUsage: {},
  loadMessages: (_chatId, messages, headMessageId, usage) =>
    set((state) => {
      const nextMessages = { ...state.messages };
      const nextExtras = { ...state.extras };
      const pendingEvents = { ...state.pendingEvents };
      for (const m of messages) {
        const pending = pendingEvents[m.id];
        delete pendingEvents[m.id];
        if (m.status === 'streaming') {
          // A reply still being written belongs to its stream: what was stored
          // is only its last checkpoint. One this window is following stays as
          // it is; one it has only buffered events for (they start when the
          // turn did) is rebuilt from them.
          if (state.messages[m.id]?.status === 'streaming') continue;
          if (pending && pending.length > 0) {
            const replayed = replayEvents({ ...m, parts: [], error: null }, emptyExtras, pending);
            nextMessages[m.id] = replayed.message;
            nextExtras[m.id] = replayed.extras;
            continue;
          }
        }
        nextMessages[m.id] = m;
      }
      return {
        messages: nextMessages,
        extras: nextExtras,
        pendingEvents,
        recordedUsage: usage ? { ...state.recordedUsage, ...usage } : state.recordedUsage,
        chats: headMessageId === null ? state.chats : state.chats.map((c) => (c.id === _chatId ? { ...c, headMessageId } : c)),
      };
    }),

  registerMessage: (message) =>
    set((state) => {
      if (state.messages[message.id]) return state; // already known -- never clobber further-along live state.

      const pending = state.pendingEvents[message.id];
      const { message: finalMessage, extras: finalExtras } =
        pending && pending.length > 0 ? replayEvents(message, emptyExtras, pending) : { message, extras: emptyExtras };

      const nextPending = { ...state.pendingEvents };
      delete nextPending[message.id];

      return {
        messages: { ...state.messages, [message.id]: finalMessage },
        extras: { ...state.extras, [message.id]: finalExtras },
        pendingEvents: nextPending,
      };
    }),

  dropAsk: (askId) =>
    set((state) => {
      let changed = false;
      const extras = { ...state.extras };
      for (const [messageId, e] of Object.entries(state.extras)) {
        const asks = e.pendingAsks ?? [];
        if (asks.some((a) => a.id === askId)) {
          extras[messageId] = { ...e, pendingAsks: asks.filter((a) => a.id !== askId) };
          changed = true;
        }
      }
      return changed ? { extras } : {};
    }),

  chatHelpers: {},
  backgroundApprovals: {},
  setChatBackground: (chatId, helpers, approvals) =>
    set((state) => ({ chatHelpers: { ...state.chatHelpers, [chatId]: helpers }, backgroundApprovals: { ...state.backgroundApprovals, [chatId]: approvals } })),
  chatNotes: {},
  sentNotes: loadSentNotes(),
  returnedNotes: [],
  earlyResolved: {},
  noteSent: (note) =>
    set((state) => {
      if (!state.earlyResolved[note.id]) return { sentNotes: { ...state.sentNotes, [note.id]: note } };
      const { [note.id]: _consumed, ...earlyResolved } = state.earlyResolved;
      return { earlyResolved };
    }),
  noteTakenBack: (note) =>
    set((state) => {
      const { [note.id]: _taken, ...sentNotes } = state.sentNotes;
      return { sentNotes, returnedNotes: [...state.returnedNotes, { ...note, takenBack: true }] };
    }),
  takeReturnedNotes: (chatId) => {
    const taken = get().returnedNotes.filter((n) => n.chatId === chatId);
    if (taken.length > 0) set((state) => ({ returnedNotes: state.returnedNotes.filter((n) => n.chatId !== chatId) }));
    return taken;
  },
  setChatNotes: (chatId, notes, outcomes) =>
    set((state) => {
      const waiting = new Set(notes.map((n) => n.id));
      const delivered = new Set(outcomes.filter((o) => o.outcome === 'folded' || o.outcome === 'turn' || o.outcome === 'removed').map((o) => o.noteId));
      const sentNotes = { ...state.sentNotes };
      const lost: ReplyNote[] = [];
      for (const note of Object.values(state.sentNotes)) {
        if (note.chatId !== chatId || waiting.has(note.id)) continue;
        delete sentNotes[note.id];
        if (!delivered.has(note.id)) lost.push(note);
      }
      // A reply that shows the note was read is word enough, with no outcome kept for it.
      const read = lost.length > 0 ? readNoteIds(state, chatId) : new Set<string>();
      const back = lost.filter((n) => !read.has(n.id));
      return { chatNotes: { ...state.chatNotes, [chatId]: notes }, sentNotes, returnedNotes: [...state.returnedNotes, ...back] };
    }),
  applyChatEvent: (chatId, event) => {
    if (event.type === 'helpers') {
      set((state) => ({ chatHelpers: { ...state.chatHelpers, [chatId]: event.helpers } }));
      return;
    }
    if (event.type === 'messages-changed') {
      set((state) => ({ chatReloads: bump(state.chatReloads, chatId) }));
      return;
    }
    if (event.type === 'notes') {
      set((state) => ({ chatNotes: { ...state.chatNotes, [chatId]: event.notes } }));
      return;
    }
    if (event.type === 'note-resolved') {
      set((state) => {
        const { [event.noteId]: _resolved, ...sentNotes } = state.sentNotes;
        const back = event.outcome === 'returned' && event.clientId === CLIENT_ID && event.note;
        // This tab's note, resolved before its send returned: `noteSent` mustn't then remember it.
        // (Never `removed`: taking a note back needs its id, so its send has returned.)
        const early = event.clientId === CLIENT_ID && event.outcome !== 'removed' && !(event.noteId in state.sentNotes);
        return {
          sentNotes,
          ...(back ? { returnedNotes: [...state.returnedNotes, event.note as ReplyNote] } : {}),
          ...(early ? { earlyResolved: { ...state.earlyResolved, [event.noteId]: true as const } } : {}),
        };
      });
      return;
    }
    const state = get();
    const background = state.backgroundApprovals[chatId] ?? [];
    // The server marks a background helper's card; a reply's own goes to the reply, loaded here yet or not.
    if (event.type === 'approval-request' && 'background' in event && event.background === true) {
      set({ backgroundApprovals: { ...state.backgroundApprovals, [chatId]: [...background.filter((r) => r.id !== event.request.id), event.request] } });
      return;
    }
    if (event.type === 'approval-resolved' && background.some((r) => r.id === event.requestId)) {
      set({ backgroundApprovals: { ...state.backgroundApprovals, [chatId]: background.filter((r) => r.id !== event.requestId) } });
      return;
    }
    state.applyTurnEvent(event);
  },

  dropApproval: (requestId) =>
    set((state) => {
      let changed = false;
      const extras = { ...state.extras };
      const backgroundApprovals = { ...state.backgroundApprovals };
      for (const [chatId, list] of Object.entries(state.backgroundApprovals)) {
        if (!list.some((r) => r.id === requestId)) continue;
        backgroundApprovals[chatId] = list.filter((r) => r.id !== requestId);
        changed = true;
      }
      for (const [messageId, e] of Object.entries(state.extras)) {
        if (e.pendingApprovals.some((r) => r.id === requestId)) {
          extras[messageId] = { ...e, pendingApprovals: e.pendingApprovals.filter((r) => r.id !== requestId) };
          changed = true;
        }
      }
      return changed ? { extras, backgroundApprovals } : {};
    }),

  applyTurnEvent: (event) =>
    set((state) => {
      const existing = state.messages[event.messageId];
      if (existing) {
        const { message, extras } = applyEventToMessage(existing, state.extras[event.messageId] ?? emptyExtras, event);
        return {
          messages: { ...state.messages, [event.messageId]: message },
          extras: { ...state.extras, [event.messageId]: extras },
        };
      }
      // Unknown to us yet -- buffer, don't drop (see this action's doc).
      const prior = state.pendingEvents[event.messageId] ?? [];
      return { pendingEvents: { ...state.pendingEvents, [event.messageId]: [...prior, event] } };
    }),

  applyHello: (buffers) =>
    set((state) => {
      const messages = { ...state.messages };
      const extras = { ...state.extras };
      const pendingEvents = { ...state.pendingEvents };

      for (const buf of buffers) {
        const existing = messages[buf.messageId];
        if (existing) {
          const replayed = applyHelloBuffer(existing, buf.events, buf.status);
          messages[buf.messageId] = replayed.message;
          extras[buf.messageId] = replayed.extras;
          delete pendingEvents[buf.messageId];
        } else {
          // Not known locally yet -- the hello buffer is authoritative and
          // already contains everything since turn start, so it REPLACES
          // (never appends to) whatever was pending.
          pendingEvents[buf.messageId] = buf.events;
        }
      }

      return { messages, extras, pendingEvents };
    }),

  resetMessageForRetry: (messageId) =>
    set((state) => {
      const existing = state.messages[messageId];
      if (!existing) return state;
      return {
        messages: { ...state.messages, [messageId]: { ...existing, parts: [], status: 'streaming', error: null } },
        extras: { ...state.extras, [messageId]: emptyExtras },
      };
    }),

  inspectorCollapsed: loadInspectorCollapsed(),
  setInspectorCollapsed: (collapsed) => set({ inspectorCollapsed: collapsed }),
  inspectorOverlayOpen: false,
  setInspectorOverlayOpen: (open) => set({ inspectorOverlayOpen: open }),
  projectPage: null,
  openProjectPage: (page) => set({ projectPage: page }),
  closeProjectPage: () => set({ projectPage: null }),
  schedulesPage: null,
  openSchedules: (prefill) => set({ schedulesPage: prefill ? { prefill } : {} }),
  closeSchedules: () => set({ schedulesPage: null }),
  schedulesVersion: 0,
}));

/** How many tool calls are waiting for approval across the whole app (the tray's count: questions and plans aren't counted). */
export const selectPendingApprovalCount = (s: OtherBenchState): number => Object.values(s.appPendingApprovals).filter((p) => p.kind === undefined).length;

// Tabs, layout and panes, and whether the inspector is collapsed, are remembered on this device;
// the notes this tab sent, in this tab.
useOtherBenchStore.subscribe((state, previous) => {
  if (state.paneState !== previous.paneState) savePaneState(state.paneState);
  if (state.inspectorCollapsed !== previous.inspectorCollapsed) saveInspectorCollapsed(state.inspectorCollapsed);
  if (state.sentNotes !== previous.sentNotes) saveSentNotes(state.sentNotes);
});
