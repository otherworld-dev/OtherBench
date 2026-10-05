import { create } from 'zustand';
import type { TurnEvent } from '@grunt/core/domain/turn.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import type { Connection, ModelInfo, Profile } from '@grunt/core/types/config.js';
import type { CanonMessage, MessageStatus } from '@grunt/core/types/messages.js';
import type { AppEvent, AppEventsHello, PendingApprovalSummary } from '@grunt/core/types/events.js';
import type { RecordedUsage } from '@grunt/core/types/usage.js';
import {
  closeTab as closePaneTab,
  focusPane as focusPaneIn,
  forgetChat,
  loadPaneState,
  moveTab as movePaneTab,
  openTab as openPaneTab,
  savePaneState,
  setLayout as setPaneLayout,
  showChat,
  type Layout,
  type PaneState,
} from './panes.js';
import { applyEventToMessage, applyHelloBuffer, emptyExtras, replayEvents, type MessageExtras } from './reducer.js';

/** One entry of an SSE `hello` reply's `inFlight` array (routes/turns.ts). */
export interface HelloBuffer {
  messageId: string;
  status: MessageStatus;
  events: TurnEvent[];
}

export type StreamConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

export interface GruntState {
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
  /** Local-only optimistic (or server-confirmed) head move -- see api.turns.setHead. */
  setHeadMessageId(chatId: string, messageId: string): void;
  /** The quick-chat hotkey and whether registering it worked (desktop only; Task 37). Null until tried. */
  hotkeyStatus: { accelerator: string; error: string | null } | null;
  setHotkeyStatus(status: { accelerator: string; error: string | null }): void;
  /** Tool calls waiting for approval anywhere in the app, by request id, from `GET /api/events` (Task 34). */
  appPendingApprovals: Record<string, PendingApprovalSummary>;
  /** Replies being written anywhere in the app: chat id by message id (#824). */
  appRunningTurns: Record<string, string>;
  /** The events stream's `hello`: replaces the pending approvals and running replies with the server's lists. */
  applyAppHello(hello: AppEventsHello): void;
  /** One app-wide event: keeps chats and the pending approvals current. */
  applyAppEvent(event: AppEvent): void;
  /** Mirrors the server recording a keep on a compare variant (POST .../head) -- see `CanonMessage.keptAt`. */
  markKept(messageId: string, at: number): void;

  // --- projects ---------------------------------------------------------------
  projects: Project[];
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

  /** Bulk-hydrates a chat's whole message tree from `GET /chats/:id/messages`. Authoritative: replaces, never merges. */
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

export const useGruntStore = create<GruntState>()((set) => ({
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
  closeTab: (chatId) => set((state) => ({ paneState: closePaneTab(synced(state), chatId) })),
  moveTab: (chatId, beforeId) => set((state) => ({ paneState: movePaneTab(synced(state), chatId, beforeId) })),
  setLayout: (layout) => set((state) => withPanes(setPaneLayout(synced(state), layout))),
  focusPane: (index) => set((state) => withPanes(focusPaneIn(synced(state), index))),
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
  applyAppHello: (hello) =>
    set({
      appPendingApprovals: Object.fromEntries(hello.pendingApprovals.map((p) => [p.requestId, p])),
      appRunningTurns: Object.fromEntries((hello.runningTurns ?? []).map((t) => [t.messageId, t.chatId])),
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
          const { chatId, messageId, requestId, toolName } = event;
          return { appPendingApprovals: { ...state.appPendingApprovals, [requestId]: { chatId, messageId, requestId, toolName } } };
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
          return { appRunningTurns: running };
        }
        case 'turn-finished': {
          // Approvals end with their turn.
          const entries = Object.entries(state.appPendingApprovals);
          const kept = entries.filter(([, p]) => p.messageId !== event.messageId);
          const running = { ...state.appRunningTurns };
          delete running[event.messageId];
          return {
            appRunningTurns: running,
            ...(kept.length === entries.length ? {} : { appPendingApprovals: Object.fromEntries(kept) }),
          };
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
  setProjects: (projects) => set({ projects }),
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
      projects: state.projects.filter((p) => p.id !== id),
      chats: state.chats.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)),
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
      for (const m of messages) nextMessages[m.id] = m;
      return {
        messages: nextMessages,
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

  dropApproval: (requestId) =>
    set((state) => {
      let changed = false;
      const extras = { ...state.extras };
      for (const [messageId, e] of Object.entries(state.extras)) {
        if (e.pendingApprovals.some((r) => r.id === requestId)) {
          extras[messageId] = { ...e, pendingApprovals: e.pendingApprovals.filter((r) => r.id !== requestId) };
          changed = true;
        }
      }
      return changed ? { extras } : {};
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

  inspectorCollapsed: false,
  setInspectorCollapsed: (collapsed) => set({ inspectorCollapsed: collapsed }),
}));

/** How many tool calls are waiting for approval across the whole app. */
export const selectPendingApprovalCount = (s: GruntState): number => Object.keys(s.appPendingApprovals).length;

// Tabs, layout and panes are remembered on this device.
useGruntStore.subscribe((state, previous) => {
  if (state.paneState !== previous.paneState) savePaneState(state.paneState);
});
