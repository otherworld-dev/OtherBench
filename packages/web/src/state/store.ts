import { create } from 'zustand';
import { chatsWorkingElsewhere } from './peerActivity.js';
import type { Project } from '@otherbench/core/ports/store.js';
import type { ReplyNote } from '@otherbench/core/types/notes.js';
import { CLIENT_ID } from '../lib/clientId.js';
import { ALL_APPS_TAB_ID } from './allAppsTab.js';
import { appTabId } from './appTab.js';
import { loadMode, saveMode, type Mode } from './mode.js';
import { openIn, showWindow } from '../desktop/bridge.js';
import { loadUndocked, windowForMode, windowRole, type DockView, type OpenRequest, type WindowRole } from '../desktop/windows.js';
import {
  closeTab as closePaneTab,
  focusPane as focusPaneIn,
  forgetApp,
  forgetChat,
  forgetProject,
  loadPaneState,
  moveTab as movePaneTab,
  openTab as openPaneTab,
  placeInPane,
  savePaneState,
  setLayout as setPaneLayout,
  setSplitSizes as setPaneSplitSizes,
  showChat,
  toggleMaximised as togglePaneMaximised,
  togglePanePin as togglePanePinIn,
} from './panes.js';
import { announceAccountEvent, reloadOnAccountEvent } from './claudeAccounts.js';
import { prunePool } from './messagePool.js';
import { applyEventToMessage, applyHelloBuffer, emptyExtras, replayEvents } from './reducer.js';
import { forgetInBoth, inMode, inPanesOf, modeOfTab, movedModes, otherMode, paneStateKey, refiled, synced, toastIfNoRoom, withPanes } from './storePanes.js';
import {
  DECK_VIEWS_STORAGE_KEY,
  loadCodePanelTab,
  loadDeckViews,
  loadInspectorCollapsed,
  loadIssueViews,
  loadOverviewOpen,
  loadSentNotes,
  loadWikiViews,
  saveCodePanelTab,
  saveInspectorCollapsed,
  saveIssueViews,
  saveOverviewOpen,
  saveSentNotes,
  saveViews,
  WIKI_VIEWS_STORAGE_KEY,
} from './storePersistence.js';
import type { OtherBenchState } from './storeTypes.js';

// The store's shape, the mode and pane-state helpers and what it keeps in storage live beside it
// (storeTypes.ts, storePanes.ts, storePersistence.ts); what callers import is exported here too.
export type {
  AppPageState,
  CodePanelTab,
  DeckView,
  HelloBuffer,
  IssueState,
  IssueView,
  OtherBenchState,
  ProjectPageState,
  ReturnedNote,
  SchedulesPageState,
  StreamConnectionStatus,
  WikiView,
} from './storeTypes.js';
export {
  CODE_PANEL_TAB_STORAGE_KEY,
  DECK_VIEWS_STORAGE_KEY,
  INSPECTOR_COLLAPSED_STORAGE_KEY,
  ISSUE_VIEWS_STORAGE_KEY,
  loadCodePanelTab,
  loadDeckViews,
  loadInspectorCollapsed,
  loadIssueViews,
  loadOverviewOpen,
  loadWikiViews,
  OVERVIEW_OPEN_STORAGE_KEY,
  SENT_NOTES_STORAGE_KEY,
  WIKI_VIEWS_STORAGE_KEY,
} from './storePersistence.js';

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

/** This page's window (desktop/windows.ts): the main one, or an undocked Code or Overview window. */
export const WINDOW_ROLE: WindowRole = windowRole();

const initialUndocked = loadUndocked();

/**
 * Whether this window holds both modes: only the main one, and only while Code is docked. A window
 * holding one mode never saves the other's pane state or the mode, since the window that holds them does.
 */
const holdsBoth = (undocked: readonly DockView[]): boolean => WINDOW_ROLE === 'main' && !undocked.includes('code');

/** Set while this window opens what another handed it (`openHandedOver`). */
let handedOver = false;

/**
 * Opens here what another window handed over: whatever this window's undocked list says, it is never
 * passed on again, so two windows that disagree can't send a request back and forth for ever.
 */
export function openHandedOver(open: () => void): void {
  handedOver = true;
  try {
    open();
  } finally {
    handedOver = false;
  }
}

/**
 * Hands `request` to the window holding `mode` when that isn't this one, and says so: then the caller
 * changes nothing here. The Overview window holds no mode, so everything it opens goes elsewhere.
 * Something handed over from another window is always opened here (`openHandedOver`).
 */
export function sentElsewhere(mode: Mode, request: OpenRequest): boolean {
  if (handedOver) return false;
  const target = windowForMode(mode, useOtherBenchStore.getState().undocked, WINDOW_ROLE);
  if (target === WINDOW_ROLE) return false;
  openIn(target, request).catch((err: unknown) => console.error(`[otherbench-web] failed to open that in the ${target} window:`, err));
  return true;
}

/** Brings forward the window holding `mode` when that isn't this one, and says so. */
function shownElsewhere(mode: Mode, undocked: readonly DockView[]): boolean {
  const target = windowForMode(mode, undocked, WINDOW_ROLE);
  if (target === WINDOW_ROLE) return false;
  showWindow(target).catch((err: unknown) => console.error(`[otherbench-web] failed to bring the ${target} window forward:`, err));
  return true;
}

const initialMode: Mode = WINDOW_ROLE === 'code' ? 'code' : holdsBoth(initialUndocked) ? loadMode() : 'chat';
const initialPanes = loadPaneState(paneStateKey(initialMode));
const initialOtherPanes = loadPaneState(paneStateKey(otherMode(initialMode)));

/** How many things need you across apps, for the badge: 0 until the Overview is first fetched. */
export const selectOverviewTotal = (s: OtherBenchState): number => s.overview?.total ?? 0;

/** Counts Ctrl+` and Ctrl+Shift+` presses, so each request is a new one (`terminalRequest.n`). */
let terminalRequests = 0;

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

/** A computer session as the banner keeps it: a last action, and the paired machine it was started from, only when each is text. */
function computerSessionOf(lastAction: unknown, startedFrom?: unknown): { lastAction?: string; startedFrom?: string } {
  return { ...(typeof lastAction === 'string' ? { lastAction } : {}), ...(typeof startedFrom === 'string' ? { startedFrom } : {}) };
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
  openTab: (chatId) => {
    if (sentElsewhere(modeOfTab(chatId, get().chats) ?? get().mode, { kind: 'tab', chatId })) return;
    set((state) => {
      const view = inMode(state, modeOfTab(chatId, state.chats) ?? state.mode);
      return { ...view, overviewOpen: false, ...withPanes(openPaneTab(synced(view), chatId)) };
    });
    toastIfNoRoom(get().paneState, chatId);
  },
  // A closed viewer tab can hand its pane back to its chat, so the active chat follows the pane.
  closeTab: (chatId) => set((state) => withPanes(closePaneTab(synced(state), chatId))),
  moveTab: (chatId, beforeId) => set((state) => ({ paneState: movePaneTab(synced(state), chatId, beforeId) })),
  setLayout: (layout) => set((state) => withPanes(setPaneLayout(synced(state), layout))),
  focusPane: (index) => set((state) => withPanes(focusPaneIn(synced(state), index))),
  togglePanePin: (index) => set((state) => ({ paneState: togglePanePinIn(synced(state), index) })),
  placeChat: (index, chatId) => {
    if (sentElsewhere(modeOfTab(chatId, get().chats) ?? get().mode, { kind: 'chat', chatId })) return;
    set((state) => {
      const view = inMode(state, modeOfTab(chatId, state.chats) ?? state.mode);
      // Another mode's panes aren't the ones the user pointed at.
      const panes = view.mode === state.mode ? placeInPane(synced(view), index, chatId) : showChat(synced(view), chatId);
      return { ...view, overviewOpen: false, ...withPanes(panes) };
    });
  },
  setSplitSizes: (key, sizes) => set((state) => ({ paneState: setPaneSplitSizes(state.paneState, key, sizes) })),
  toggleMaximised: () => set((state) => ({ paneState: togglePaneMaximised(state.paneState) })),
  // The whole list, so every chat is checked: the saved tabs may predate a move made on another machine.
  setChats: (chats) => set((state) => ({ chats, ...refiled(state, chats) })),
  upsertChat: (chat) =>
    set((state) => {
      const idx = state.chats.findIndex((c) => c.id === chat.id);
      if (idx === -1) return { chats: [...state.chats, chat] };
      const next = [...state.chats];
      next[idx] = chat;
      return { chats: next, ...refiled(state, movedModes(state.chats[idx], chat)) };
    }),
  removeChat: (chatId) =>
    set((state) => {
      // The chat's Issues view goes with it.
      const { [chatId]: view, ...issueViews } = state.issueViews;
      const { [chatId]: deckView, ...deckViews } = state.deckViews;
      const { [chatId]: wikiView, ...wikiViews } = state.wikiViews;
      return {
        chats: state.chats.filter((c) => c.id !== chatId),
        ...forgetInBoth(state, (p) => forgetChat(p, chatId)),
        ...(view ? { issueViews } : {}),
        ...(deckView ? { deckViews } : {}),
        ...(wikiView ? { wikiViews } : {}),
      };
    }),
  // Fills the focused pane (or, with that pinned, the next free one), or focuses the pane already showing the chat, in the chat's own mode.
  setActiveChatId: (chatId) => {
    if (chatId !== null && sentElsewhere(modeOfTab(chatId, get().chats) ?? get().mode, { kind: 'chat', chatId })) return;
    set((state) => {
      const view = inMode(state, modeOfTab(chatId, state.chats) ?? state.mode);
      return { ...view, overviewOpen: false, ...withPanes(showChat(synced(view), chatId)) };
    });
    toastIfNoRoom(get().paneState, chatId);
  },
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
  lastTurnFinished: null,
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
    set((state) => ({
      appPendingApprovals: Object.fromEntries(hello.pendingApprovals.map((p) => [p.requestId, p])),
      appRunningTurns: Object.fromEntries((hello.runningTurns ?? []).map((t) => [t.messageId, t.chatId])),
      computerSessions: Object.fromEntries((hello.computerSessions ?? []).map((c) => [c.chatId, computerSessionOf(c.lastAction, c.startedFrom)])),
      appBackgroundChats: Object.fromEntries((hello.backgroundChats ?? []).filter((c) => c.count > 0).map((c) => [c.chatId, c.count])),
      // A paired machine's schedules may have changed while this stream was down.
      peerSchedulesVersion: state.peerSchedulesVersion + 1,
    })),
  applyAppEvent: (event) => {
    announceAccountEvent(event, (id) => get().chats.find((c) => c.id === id)?.title);
    reloadOnAccountEvent(event);
    set((state) => {
      switch (event.type) {
        case 'chat-created':
        case 'chat-updated': {
          // A chat new to this window is never dropped: it may be the one just opened, before its row arrived.
          const idx = state.chats.findIndex((c) => c.id === event.chat.id);
          if (idx === -1) return { chats: [...state.chats, event.chat] };
          const chats = [...state.chats];
          chats[idx] = event.chat;
          // Moved into or out of an app (here, in another window or on the other machine): it leaves the mode it left.
          return { chats, ...refiled(state, movedModes(state.chats[idx], event.chat)) };
        }
        case 'chat-deleted':
          return { chats: state.chats.filter((c) => c.id !== event.chatId), ...forgetInBoth(state, (p) => forgetChat(p, event.chatId)) };
        case 'approval-requested': {
          const { chatId, messageId, requestId, toolName, kind, at } = event;
          const summary = { chatId, messageId, requestId, toolName, ...(kind ? { kind } : {}), ...(at !== undefined ? { at } : {}) };
          return { appPendingApprovals: { ...state.appPendingApprovals, [requestId]: summary } };
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
            lastTurnFinished: { chatId: event.chatId, messageId: event.messageId },
            ...(kept.length === entries.length ? {} : { appPendingApprovals: Object.fromEntries(kept) }),
            ...(stale ? { chatReloads: bump(state.chatReloads, event.chatId) } : {}),
          };
        }
        case 'sync-applied':
          return { syncRevision: state.syncRevision + 1 };
        case 'terminals-changed':
          return { terminalsChanged: { appId: event.appId } };
        case 'schedules-changed':
        case 'schedule-run-started':
        case 'schedule-run-finished':
          return { schedulesVersion: state.schedulesVersion + 1 };
        case 'peer-schedules':
        case 'peer-status':
        case 'peers-changed':
          return { peerSchedulesVersion: state.peerSchedulesVersion + 1 };
        case 'computer-session': {
          const next = { ...state.computerSessions };
          if (event.active) {
            // An event with no last action (the session started, say) keeps the one already shown.
            const before = next[event.chatId] ?? {};
            next[event.chatId] = computerSessionOf(event.lastAction ?? before.lastAction, event.startedFrom ?? before.startedFrom);
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
    });
  },
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
      const gone = state.projects.filter((p) => !kept.has(p.id));
      return { projects, projectsLoaded: true, ...forgetInBoth(state, (panes) => gone.reduce((next, p) => forgetProject(next, p.id), panes)) };
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
      ...forgetInBoth(state, (panes) => forgetProject(panes, id)),
    })),

  apps: [],
  appsLoaded: false,
  setApps: (apps) =>
    set((state) => {
      // An app deleted elsewhere (another tab or machine) arrives as a list without it: its home closes too.
      const kept = new Set(apps.map((a) => a.id));
      const gone = state.apps.filter((a) => !kept.has(a.id));
      return { apps, appsLoaded: true, ...inPanesOf(state, 'code', (panes) => gone.reduce((next, a) => forgetApp(next, a.id), panes)) };
    }),
  upsertApp: (app) =>
    set((state) => {
      const idx = state.apps.findIndex((a) => a.id === app.id);
      if (idx === -1) return { apps: [...state.apps, app] };
      const next = [...state.apps];
      next[idx] = app;
      return { apps: next };
    }),
  removeApp: (id) =>
    set((state) => {
      // Its chats go back to Chat mode, so they leave Code mode's tabs, as any chat moved out of an app does.
      const moved = state.chats.filter((c) => c.appId === id).map((c) => c.id);
      return {
        apps: state.apps.filter((a) => a.id !== id),
        chats: state.chats.map((c) => (c.appId === id ? { ...c, appId: null } : c)),
        ...inPanesOf(state, 'code', (panes) => moved.reduce((next, chatId) => forgetChat(next, chatId), forgetApp(panes, id))),
      };
    }),
  appFolders: [],
  setAppFolders: (appFolders) => set({ appFolders }),
  upsertAppFolder: (folder) =>
    set((state) => {
      const idx = state.appFolders.findIndex((f) => f.id === folder.id);
      if (idx === -1) return { appFolders: [...state.appFolders, folder] };
      const next = [...state.appFolders];
      next[idx] = folder;
      return { appFolders: next };
    }),
  removeAppFolder: (id) =>
    set((state) => ({
      appFolders: state.appFolders.filter((f) => f.id !== id),
      apps: state.apps.map((a) => (a.folderId === id ? { ...a, folderId: null } : a)),
    })),
  mode: initialMode,
  otherPaneState: initialOtherPanes,
  setMode: (mode) => {
    if (shownElsewhere(mode, get().undocked)) return;
    set((state) => ({ ...inMode(state, mode), overviewOpen: false }));
  },
  overview: null,
  setOverview: (overview) => set({ overview }),
  // Only the main window's choice is remembered; an undocked Overview isn't open in any other.
  overviewOpen: WINDOW_ROLE === 'main' && !initialUndocked.includes('overview') && loadOverviewOpen(),
  setOverviewOpen: (open) => {
    if (open && get().undocked.includes('overview') && WINDOW_ROLE !== 'overview') {
      showWindow('overview').catch((err: unknown) => console.error('[otherbench-web] failed to bring the Overview window forward:', err));
      return;
    }
    set({ overviewOpen: open });
  },
  undocked: initialUndocked,
  setUndocked: (views) =>
    set((state) => {
      if (WINDOW_ROLE !== 'main') return { undocked: views };
      const codeOut = views.includes('code');
      // Code left: the main window goes back to Chat mode, Code's pane state put away as it was (already saved).
      // Code came back: its pane state is read again, as the Code window left it.
      const modes = codeOut && state.mode === 'code' ? inMode(state, 'chat') : {};
      const codeBack = !codeOut && state.undocked.includes('code') && state.mode === 'chat' ? { otherPaneState: loadPaneState(paneStateKey('code')) } : {};
      return { undocked: views, ...modes, ...codeBack, ...(views.includes('overview') ? { overviewOpen: false } : {}) };
    }),
  openAppHome: (appId) => {
    if (sentElsewhere('code', { kind: 'home', appId })) return;
    set((state) => {
      const view = inMode(state, 'code');
      // Shown in the pane, not made a tab: only what the user asks to be a tab becomes one.
      return { ...view, overviewOpen: false, ...withPanes(showChat(synced(view), appTabId(appId))) };
    });
    toastIfNoRoom(get().paneState, appTabId(appId));
  },
  openAllApps: () => {
    if (sentElsewhere('code', { kind: 'all-apps' })) return;
    set((state) => {
      const view = inMode(state, 'code');
      return { ...view, overviewOpen: false, ...withPanes(showChat(synced(view), ALL_APPS_TAB_ID)) };
    });
    toastIfNoRoom(get().paneState, ALL_APPS_TAB_ID);
  },
  codePanelTab: loadCodePanelTab(),
  setCodePanelTab: (tab) => set({ codePanelTab: tab }),
  terminalsChanged: null,
  terminalRequest: null,
  requestTerminal: (kind) => set({ terminalRequest: { kind, n: ++terminalRequests } }),
  takeTerminalRequest: () => {
    const request = get().terminalRequest;
    if (request !== null) set({ terminalRequest: null });
    return request;
  },
  composerPrefills: {},
  issueViews: loadIssueViews(),
  setIssueView: (owner, view) =>
    set((state) => ({ issueViews: { ...state.issueViews, [owner]: { state: 'open', selected: null, ...state.issueViews[owner], ...view } } })),
  deckViews: loadDeckViews(),
  setDeckView: (owner, view) =>
    set((state) => ({ deckViews: { ...state.deckViews, [owner]: { stackId: null, selected: null, ...state.deckViews[owner], ...view } } })),
  wikiViews: loadWikiViews(),
  setWikiView: (owner, view) =>
    set((state) => ({ wikiViews: { ...state.wikiViews, [owner]: { expanded: [], selected: null, ...state.wikiViews[owner], ...view } } })),
  deckBoards: {},
  deckCards: {},
  wikiTrees: {},
  wikiPages: {},
  linkLists: {},
  cacheDeckBoard: (appId, board) => set((state) => ({ deckBoards: { ...state.deckBoards, [appId]: board } })),
  cacheDeckCard: (card) => set((state) => ({ deckCards: { ...state.deckCards, [card.id]: card } })),
  forgetDeckCard: (cardId) =>
    set((state) => {
      if (!(cardId in state.deckCards)) return {};
      const { [cardId]: _gone, ...deckCards } = state.deckCards;
      return { deckCards };
    }),
  cacheWikiTree: (appId, tree) => set((state) => ({ wikiTrees: { ...state.wikiTrees, [appId]: tree } })),
  cacheWikiPage: (appId, page) => set((state) => ({ wikiPages: { ...state.wikiPages, [`${appId}#${page.id}`]: page } })),
  cacheLinkList: (appId, list) => set((state) => ({ linkLists: { ...state.linkLists, [appId]: list } })),
  issueDrafts: {},
  setIssueDraft: (key, text) =>
    set((state) => {
      const { [key]: _old, ...rest } = state.issueDrafts;
      return { issueDrafts: text === '' ? rest : { ...rest, [key]: text } };
    }),
  issueLists: {},
  issueDetails: {},
  cacheIssueList: (appId, issueState, list) => set((state) => ({ issueLists: { ...state.issueLists, [`${appId}:${issueState}`]: list } })),
  cacheIssue: (appId, issue) => set((state) => ({ issueDetails: { ...state.issueDetails, [`${appId}#${issue.number}`]: issue } })),
  prefillComposer:(chatId, text) => set((state) => ({ composerPrefills: { ...state.composerPrefills, [chatId]: text } })),
  takeComposerPrefill: (chatId) => {
    const text = get().composerPrefills[chatId];
    if (text === undefined) return null;
    set((state) => {
      const { [chatId]: _taken, ...composerPrefills } = state.composerPrefills;
      return { composerPrefills };
    });
    return text;
  },
  composerFocus: null,
  focusComposer: (chatId) => set({ composerFocus: chatId }),
  takeComposerFocus: (chatId) => {
    if (get().composerFocus !== chatId) return false;
    set({ composerFocus: null });
    return true;
  },

  messages: {},
  viewedChats: [],
  pruneMessages: () => {
    const update = prunePool(get());
    if (update !== null) set(update);
  },
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
  unsureNotes: {},
  setChatNotes: (chatId, notes, outcomes, messagesLoaded = true) =>
    set((state) => {
      const waiting = new Set(notes.map((n) => n.id));
      const delivered = new Set(outcomes.filter((o) => o.outcome === 'folded' || o.outcome === 'turn' || o.outcome === 'removed').map((o) => o.noteId));
      const sentNotes = { ...state.sentNotes };
      const lost: ReplyNote[] = [];
      for (const note of Object.values(state.sentNotes)) {
        if (note.chatId !== chatId || waiting.has(note.id)) continue;
        if (delivered.has(note.id)) delete sentNotes[note.id];
        else lost.push(note);
      }
      const chatNotes = { ...state.chatNotes, [chatId]: notes };
      // The messages that may show them read aren't here yet: decided once they are, and still held meanwhile.
      if (!messagesLoaded) {
        const unsure = [...new Set([...(state.unsureNotes[chatId] ?? []), ...lost.map((n) => n.id)])];
        return { chatNotes, sentNotes, unsureNotes: { ...state.unsureNotes, [chatId]: unsure } };
      }
      for (const note of lost) delete sentNotes[note.id];
      // A reply that shows the note was read is word enough, with no outcome kept for it.
      const read = lost.length > 0 ? readNoteIds(state, chatId) : new Set<string>();
      const back = lost.filter((n) => !read.has(n.id));
      return { chatNotes, sentNotes, returnedNotes: [...state.returnedNotes, ...back] };
    }),
  settleUnsureNotes: (chatId) =>
    set((state) => {
      const ids = state.unsureNotes[chatId];
      if (!ids) return {};
      const { [chatId]: _settled, ...unsureNotes } = state.unsureNotes;
      // Those the stream has since resolved are gone from sentNotes already.
      const lost = ids.flatMap((id) => (state.sentNotes[id] ? [state.sentNotes[id]] : []));
      if (lost.length === 0) return { unsureNotes };
      const sentNotes = { ...state.sentNotes };
      for (const note of lost) delete sentNotes[note.id];
      const read = readNoteIds(state, chatId);
      return { unsureNotes, sentNotes, returnedNotes: [...state.returnedNotes, ...lost.filter((n) => !read.has(n.id))] };
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
  appPage: null,
  openAppPage: (page) => set({ appPage: page }),
  closeAppPage: () => set({ appPage: null }),
  schedulesPage: null,
  openSchedules: (prefill) => set({ schedulesPage: prefill ? { prefill } : {} }),
  closeSchedules: () => set({ schedulesPage: null }),
  schedulesVersion: 0,
  peerSchedulesVersion: 0,
}));

/** How many tool calls are waiting for approval across the whole app (the tray's count: questions and plans aren't counted). */
export const selectPendingApprovalCount = (s: OtherBenchState): number => Object.values(s.appPendingApprovals).filter((p) => p.kind === undefined).length;

// Tabs, layout and panes (each mode's under its own key), the mode, the Code panel's tab and whether the
// inspector is collapsed are remembered on this device; the notes this tab sent, in this tab. A mode switch
// swaps which state is showing, so both are saved again then, each under its mode's key. A window holding
// one mode (`holdsBoth`) saves only that mode's, and the Overview window none.
useOtherBenchStore.subscribe((state, previous) => {
  const switched = state.mode !== previous.mode;
  const both = holdsBoth(state.undocked);
  if (WINDOW_ROLE !== 'overview' && (switched || state.paneState !== previous.paneState)) savePaneState(state.paneState, paneStateKey(state.mode));
  if (both && (switched || state.otherPaneState !== previous.otherPaneState)) savePaneState(state.otherPaneState, paneStateKey(otherMode(state.mode)));
  if (both && switched) saveMode(state.mode);
  if (WINDOW_ROLE === 'main' && state.overviewOpen !== previous.overviewOpen) saveOverviewOpen(state.overviewOpen);
  if (state.codePanelTab !== previous.codePanelTab) saveCodePanelTab(state.codePanelTab);
  if (state.issueViews !== previous.issueViews) saveIssueViews(state.issueViews);
  if (state.deckViews !== previous.deckViews) saveViews(DECK_VIEWS_STORAGE_KEY, state.deckViews);
  if (state.wikiViews !== previous.wikiViews) saveViews(WIKI_VIEWS_STORAGE_KEY, state.wikiViews);
  if (state.inspectorCollapsed !== previous.inspectorCollapsed) saveInspectorCollapsed(state.inspectorCollapsed);
  if (state.sentNotes !== previous.sentNotes) saveSentNotes(state.sentNotes);
  // A chat switch or pane change (never a stream chunk): the message pool forgets chats nobody is looking at. Last,
  // since it sets the store again.
  const panesChanged = state.paneState.panes !== previous.paneState.panes || state.otherPaneState.panes !== previous.otherPaneState.panes;
  if (state.activeChatId !== previous.activeChatId || panesChanged) state.pruneMessages();
});
