import { create } from 'zustand';
import type { TurnEvent } from '@grunt/core/domain/turn.js';
import type { Chat } from '@grunt/core/ports/store.js';
import type { Connection, ModelInfo, Profile } from '@grunt/core/types/config.js';
import type { CanonMessage, MessageStatus } from '@grunt/core/types/messages.js';
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

  // --- chats -----------------------------------------------------------------
  chats: Chat[];
  activeChatId: string | null;
  setChats(chats: Chat[]): void;
  upsertChat(chat: Chat): void;
  removeChat(chatId: string): void;
  setActiveChatId(chatId: string | null): void;
  /** Local-only optimistic (or server-confirmed) head move -- see api.turns.setHead. */
  setHeadMessageId(chatId: string, messageId: string): void;

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
  loadMessages(chatId: string, messages: CanonMessage[], headMessageId: string | null): void;

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

export const useGruntStore = create<GruntState>()((set) => ({
  connections: [],
  models: [],
  profiles: [],
  setConnections: (connections) => set({ connections }),
  setModels: (models) => set({ models }),
  setProfiles: (profiles) => set({ profiles }),

  chats: [],
  activeChatId: null,
  setChats: (chats) => set({ chats }),
  upsertChat: (chat) =>
    set((state) => {
      const idx = state.chats.findIndex((c) => c.id === chat.id);
      if (idx === -1) return { chats: [...state.chats, chat] };
      const next = [...state.chats];
      next[idx] = chat;
      return { chats: next };
    }),
  removeChat: (chatId) => set((state) => ({ chats: state.chats.filter((c) => c.id !== chatId) })),
  setActiveChatId: (chatId) => set({ activeChatId: chatId }),
  setHeadMessageId: (chatId, messageId) =>
    set((state) => ({
      chats: state.chats.map((c) => (c.id === chatId ? { ...c, headMessageId: messageId } : c)),
    })),

  messages: {},
  extras: {},
  pendingEvents: {},
  streamStatus: 'idle',
  setStreamStatus: (status) => set({ streamStatus: status }),

  loadMessages: (_chatId, messages, headMessageId) =>
    set((state) => {
      const nextMessages = { ...state.messages };
      for (const m of messages) nextMessages[m.id] = m;
      return {
        messages: nextMessages,
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
