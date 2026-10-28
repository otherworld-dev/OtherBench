import { create } from 'zustand';
import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import type { BackgroundHelper, BackgroundMark, ChatLevelEvent } from '@otherbench/core/types/background.js';
import { chatsWorkingElsewhere } from './peerActivity.js';
import type { ScheduleTarget } from '@otherbench/core/domain/schedule.js';
import type { TurnEvent } from '@otherbench/core/domain/turn.js';
import type { App, AppFolder, Chat, Project } from '@otherbench/core/ports/store.js';
import type { Connection, ModelInfo, Profile } from '@otherbench/core/types/config.js';
import type { CanonMessage, MessageStatus } from '@otherbench/core/types/messages.js';
import type { NoteOutcome, ReplyNote } from '@otherbench/core/types/notes.js';
import { CLIENT_ID } from '../lib/clientId.js';
import type { AppEvent, AppEventsHello, PendingApprovalSummary } from '@otherbench/core/types/events.js';
import type { RecordedUsage } from '@otherbench/core/types/usage.js';
import type { IssueDetail, IssueSummary } from '@otherbench/core/types/code.js';
import type { Bookmark, DeckBoardView, DeckCardDetail, WikiPage, WikiTree } from '@otherbench/core/types/nextcloud.js';
import { parseViewTab } from '../viewer/items.js';
import { appTabId, parseAppTab } from './appTab.js';
import { loadMode, modeOfChat, saveMode, type Mode } from './mode.js';
import {
  closeTab as closePaneTab,
  CODE_PANE_STATE_STORAGE_KEY,
  focusPane as focusPaneIn,
  forgetApp,
  forgetChat,
  forgetProject,
  loadPaneState,
  PANE_STATE_STORAGE_KEY,
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
import { announceAccountEvent, reloadOnAccountEvent } from './claudeAccounts.js';
import { parseProjectTab } from './projectTab.js';
import { applyEventToMessage, applyHelloBuffer, emptyExtras, replayEvents, type MessageExtras } from './reducer.js';
import type { PeersOverview } from './api.js';
import type { Overview } from '@otherbench/core/types/overview.js';

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
/** The app form (spec 2026-10-20-code-tab-design, "Creating an app"), as `ProjectPageState`: a new app, or one to edit. */
export type AppPageState = { mode: 'create'; returnFocus?: string } | { mode: 'edit'; appId: string; returnFocus?: string };

/** The Scheduled overlay; `prefill` opens the editor for a new schedule on that chat or project. */
export type SchedulesPageState = { prefill?: ScheduleTarget };

/** A note on its way back to the box; `takenBack` when the user took it back, rather than it not being sent. */
export type ReturnedNote = ReplyNote & { takenBack?: true };

/**
 * The Code mode right panel's tabs (spec 2026-10-20-code-tab-design: Issues, Files, and Chat holding the Inspector;
 * spec 2026-10-21-code-terminal-design: Terminal).
 */
export type CodePanelTab = 'issues' | 'deck' | 'wiki' | 'links' | 'files' | 'chat' | 'terminal';
/** Where one Deck view is: the column it lists (null: open on Doing) and the card it has open, if any. */
export interface DeckView {
  stackId: number | 'archived' | null;
  selected: number | null;
}
/** Where one Wiki view is: the pages it has expanded and the page it has open, if any. */
export interface WikiView {
  expanded: number[];
  selected: number | null;
}
export type IssueState = 'open' | 'closed';
/** Where one Issues view is: which state it lists, and the issue it has open, if any. */
export interface IssueView {
  state: IssueState;
  selected: number | null;
}

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
  /** Also drops each chat from the pane state of the mode it doesn't live in (moved into or out of an app since the tabs were saved). */
  setChats(chats: Chat[]): void;
  /** A chat that moved into or out of an app also leaves the pane state of the mode it left, as `removeChat` would. */
  upsertChat(chat: Chat): void;
  /** Takes it out of both modes' pane states. */
  removeChat(chatId: string): void;
  /**
   * Shows the chat (or tab id) in the focused pane, first switching to the mode it lives in (`modeOfChat`)
   * when that isn't the one showing: "opening an app chat from anywhere switches to Code mode, and the same
   * goes for an ordinary chat and Chat mode" (spec 2026-10-20-code-tab-design). A chat this window hasn't
   * loaded, and null, stay in the mode showing.
   */
  setActiveChatId(chatId: string | null): void;
  /**
   * Tabs, layout and the chat in each pane (#824), of the mode showing (`mode`). The focused pane's chat is
   * always `activeChatId`. The other mode's are kept in `otherPaneState`.
   */
  paneState: PaneState;
  /** Adds the chat as a tab (once) and shows it in the focused pane, switching mode first as `setActiveChatId` does. */
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
   * The app event stream's latest `turn-finished`, a fresh object each time,
   * so a subscriber sees every one, two in a row in one chat included. The
   * Code tab refreshes its issues (and git) after a turn in one of the app's
   * chats (`code/useCodeRefresh.ts`, spec 2026-10-20-code-tab-design).
   */
  lastTurnFinished: { chatId: string; messageId: string } | null;
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

  // --- apps and Code mode (spec 2026-10-20-code-tab-design) -------------------
  apps: App[];
  /** The app list has arrived from the server, as `projectsLoaded`. */
  appsLoaded: boolean;
  /** An app missing from the new list (deleted elsewhere) also has its home tab closed, as `setProjects`. */
  setApps(apps: App[]): void;
  /** Inserts or replaces one app by id. */
  upsertApp(app: App): void;
  /**
   * Removes an app and, in the SAME update, takes its chats out of it (`appId: null`), mirroring the server's
   * DELETE: they go back to Chat mode, never deleted. Its home tab and its chats leave Code mode's pane state.
   */
  removeApp(id: string): void;
  /** Folders for apps in the Code sidebar, in `compareAppFolders` order as the server sends them. */
  appFolders: AppFolder[];
  setAppFolders(folders: AppFolder[]): void;
  /** Inserts or replaces one folder by id. */
  upsertAppFolder(folder: AppFolder): void;
  /** Removes a folder and, in the same update, frees its apps (`folderId: null`), as the server's DELETE does. */
  removeAppFolder(id: string): void;
  /** Which half of the window is showing. Remembered per browser, never synced. */
  mode: Mode;
  /** The pane state of the mode NOT showing, put away until `setMode` swaps it back with `paneState`. */
  otherPaneState: PaneState;
  /** Switches mode: the showing pane state is put away as it is, and the other mode's comes back with its own active chat. */
  setMode(mode: Mode): void;
  /** The Overview (what needs you across apps), or null until the first fetch. */
  overview: Overview | null;
  setOverview(overview: Overview): void;
  /** The Overview window is showing instead of the panes. Closed by choosing any chat, tab, mode or app home. Remembered per browser. */
  overviewOpen: boolean;
  setOverviewOpen(open: boolean): void;
  /** Shows the app's home (`appTabId`) in the focused pane in Code mode, switching to Code mode first. Not as a tab. */
  openAppHome(appId: string): void;
  /** The Code mode right panel's tab. Remembered per browser. */
  codePanelTab: CodePanelTab;
  setCodePanelTab(tab: CodePanelTab): void;
  /** The app event stream's latest `terminals-changed`, a fresh object each time: the Terminal tab re-reads that app's list. */
  terminalsChanged: { appId: string } | null;
  /** Ctrl+` (focus) or Ctrl+Shift+` (new), for the Terminal tab to act on; `n` grows with each. */
  terminalRequest: { kind: 'focus' | 'new'; n: number } | null;
  requestTerminal(kind: 'focus' | 'new'): void;
  /** The waiting request, which is then cleared: the Terminal tab acts on each once, even one made before it showed. */
  takeTerminalRequest(): { kind: 'focus' | 'new'; n: number } | null;
  /**
   * Text handed to a chat's composer from outside it, by chat id, not yet
   * taken: "Start a chat on this" puts an issue's number, title, URL and body
   * in the new chat's box rather than sending it (spec
   * 2026-10-20-code-tab-design, Goal 7 and "Calls I made"). The composer
   * keeps its draft in its own state, so this is a hand-off the way
   * `returnedNotes` is: the box takes it (after any draft) when it mounts or
   * when it arrives. Not persisted: a reload before the chat shows drops it,
   * as it drops a draft.
   */
  composerPrefills: Record<string, string>;
  /**
   * Each Issues view's own place, by its owner: a chat id, or an app tab's id
   * for an app home. So every chat keeps its own issue open while another chat
   * shows its own, and switching back finds it where it was. Remembered per
   * browser; a chat's goes with the chat.
   */
  issueViews: Record<string, IssueView>;
  setIssueView(owner: string, view: Partial<IssueView>): void;
  /** A half-written comment, by `${owner}#${number}`, so a chat switch doesn't lose it. Not persisted. */
  issueDrafts: Record<string, string>;
  /** Each chat's (or app home's) Deck and Wiki views, like `issueViews`: per browser, and a chat's goes with the chat. */
  deckViews: Record<string, DeckView>;
  setDeckView(owner: string, view: Partial<DeckView>): void;
  wikiViews: Record<string, WikiView>;
  setWikiView(owner: string, view: Partial<WikiView>): void;
  /** Nextcloud's last answers, shown at once while they're fetched again. Not persisted. Boards, trees and links by app id; cards by card id; pages by `${appId}#${pageId}`. */
  deckBoards: Record<string, DeckBoardView>;
  deckCards: Record<number, DeckCardDetail>;
  wikiTrees: Record<string, WikiTree>;
  wikiPages: Record<string, WikiPage>;
  linkLists: Record<string, { tag: string; bookmarks: Bookmark[] }>;
  cacheDeckBoard(appId: string, board: DeckBoardView): void;
  cacheDeckCard(card: DeckCardDetail): void;
  /** Drops a card that's gone from Nextcloud (deleted here or elsewhere), so it isn't shown again from the cache. */
  forgetDeckCard(cardId: number): void;
  cacheWikiTree(appId: string, tree: WikiTree): void;
  cacheWikiPage(appId: string, page: WikiPage): void;
  cacheLinkList(appId: string, list: { tag: string; bookmarks: Bookmark[] }): void;
  setIssueDraft(key: string, text: string): void;
  /**
   * gh's last answers, by `${appId}:${state}` for a list and `${appId}#${number}`
   * for an issue, shown at once while they're fetched again: switching chats
   * shows the other chat's issue without a Loading… wait. Not persisted.
   */
  issueLists: Record<string, { repo: string; issues: IssueSummary[] }>;
  issueDetails: Record<string, IssueDetail>;
  cacheIssueList(appId: string, state: IssueState, list: { repo: string; issues: IssueSummary[] }): void;
  cacheIssue(appId: string, issue: IssueDetail): void;
  prefillComposer(chatId: string, text: string): void;
  /** The chat's handed-over text, removed from the store, or null when there is none. */
  takeComposerPrefill(chatId: string): string | null;
  /**
   * The chat whose box should take the cursor when it shows: one just made
   * with "+" or started from a start box, so typing can begin at once. Taken
   * by the composer like a prefill. Not persisted.
   */
  composerFocus: string | null;
  focusComposer(chatId: string): void;
  /** Clears the request when it's for this chat; true when it was. */
  takeComposerFocus(chatId: string): boolean;

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
  /** The open app form, or null. Opened from Code mode's sidebar; App renders it. */
  appPage: AppPageState | null;
  openAppPage(page: AppPageState): void;
  closeAppPage(): void;
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

/*
 * Code is a whole-window mode (spec 2026-10-20-code-tab-design, "Decisions Adam
 * made"): Chat mode and Code mode each keep their own tabs and pane layout, and
 * switching swaps them. The store holds the showing mode's as `paneState`, so
 * every pane action and every component reading it works unchanged in either
 * mode, and the other mode's as `otherPaneState`, untouched until a switch
 * swaps the two. A chat lives in one mode only (`modeOfChat`), so a pane state
 * never keeps a chat of the other mode: one that moves into or out of an app
 * leaves the pane state of the mode it left, the way a deleted chat does.
 */

const otherMode = (mode: Mode): Mode => (mode === 'chat' ? 'code' : 'chat');

/** Where a mode's pane state is saved: Chat mode keeps the key every layout was saved under before Code mode. */
const paneStateKey = (mode: Mode): string => (mode === 'code' ? CODE_PANE_STATE_STORAGE_KEY : PANE_STATE_STORAGE_KEY);

type ModeView = Pick<OtherBenchState, 'mode' | 'paneState' | 'otherPaneState' | 'activeChatId'>;

/**
 * The mode a tab or pane id belongs in: an app's home in Code mode, a project's
 * page in Chat mode, a chat (or a viewer tab, by its chat) in its chat's mode.
 * Null when this window can't tell (a chat it hasn't loaded yet) or for null.
 */
function modeOfTab(id: string | null, chats: Chat[]): Mode | null {
  if (id === null) return null;
  if (parseAppTab(id) !== null) return 'code';
  if (parseProjectTab(id) !== null) return 'chat';
  const chatId = parseViewTab(id)?.chatId ?? id;
  const chat = chats.find((c) => c.id === chatId);
  return chat ? modeOfChat(chat) : null;
}

/**
 * The store's mode fields with `mode` showing. A switch puts the showing pane
 * state away exactly as it is (synced with the active chat) and brings the other
 * back with its own focused pane's chat active; the same mode changes nothing.
 */
function inMode(state: ModeView, mode: Mode): ModeView {
  if (mode === state.mode) return { mode, paneState: state.paneState, otherPaneState: state.otherPaneState, activeChatId: state.activeChatId };
  const back = state.otherPaneState;
  return { mode, paneState: back, otherPaneState: synced(state), activeChatId: back.panes[back.focusedPane] ?? null };
}

/** `forget` applied to both modes' pane states, the active chat following the showing one. */
function forgetInBoth(state: ModeView, forget: (panes: PaneState) => PaneState): Pick<OtherBenchState, 'paneState' | 'otherPaneState' | 'activeChatId'> {
  return { ...withPanes(forget(synced(state))), otherPaneState: forget(state.otherPaneState) };
}

/** `change` applied to `mode`'s pane state, whether it is showing or put away. */
function inPanesOf(state: ModeView, mode: Mode, change: (panes: PaneState) => PaneState): Partial<OtherBenchState> {
  return mode === state.mode ? withPanes(change(synced(state))) : { otherPaneState: change(state.otherPaneState) };
}

/**
 * Each of `chats` dropped (with its viewer tabs, as `forgetChat`) from the pane
 * state of the mode it doesn't live in. Nothing when no pane state held one, so
 * an update that moved nothing leaves both pane states as they were.
 */
function refiled(state: ModeView, chats: readonly Chat[]): Partial<OtherBenchState> {
  if (chats.length === 0) return {};
  const base = synced(state);
  let showing = base;
  let away = state.otherPaneState;
  for (const chat of chats) {
    if (modeOfChat(chat) === state.mode) away = forgetChat(away, chat.id);
    else showing = forgetChat(showing, chat.id);
  }
  if (showing === base && away === state.otherPaneState) return {};
  return { ...withPanes(showing), otherPaneState: away };
}

/** `after` when it moved into or out of an app since `before` (a chat this window already had), for `refiled`. */
function movedModes(before: Chat | undefined, after: Chat): Chat[] {
  return before !== undefined && modeOfChat(before) !== modeOfChat(after) ? [after] : [];
}

const initialMode = loadMode();
const initialPanes = loadPaneState(paneStateKey(initialMode));
const initialOtherPanes = loadPaneState(paneStateKey(otherMode(initialMode)));

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

/** localStorage key: whether the Overview window is showing. Per browser. */
export const OVERVIEW_OPEN_STORAGE_KEY = 'otherbench.overviewOpen';

export function loadOverviewOpen(): boolean {
  try {
    return window.localStorage.getItem(OVERVIEW_OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveOverviewOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OVERVIEW_OPEN_STORAGE_KEY, String(open));
  } catch {
    // storage blocked or full -- the choice still applies for this session.
  }
}

/** How many things need you across apps, for the badge: 0 until the Overview is first fetched. */
export const selectOverviewTotal = (s: OtherBenchState): number => s.overview?.total ?? 0;

/** localStorage key: the Code mode right panel's tab. Per browser. */
export const CODE_PANEL_TAB_STORAGE_KEY = 'otherbench.codePanelTab';

/** Counts Ctrl+` and Ctrl+Shift+` presses, so each request is a new one (`terminalRequest.n`). */
let terminalRequests = 0;

/** The stored tab; Issues for anything missing, unreadable or unknown. */
export function loadCodePanelTab(): CodePanelTab {
  try {
    const raw = window.localStorage.getItem(CODE_PANEL_TAB_STORAGE_KEY);
    return raw === 'deck' || raw === 'wiki' || raw === 'links' || raw === 'files' || raw === 'chat' || raw === 'terminal' ? raw : 'issues';
  } catch {
    return 'issues';
  }
}

function saveCodePanelTab(tab: CodePanelTab): void {
  try {
    window.localStorage.setItem(CODE_PANEL_TAB_STORAGE_KEY, tab);
  } catch {
    // storage blocked or full -- the tab still applies for this session.
  }
}

/** localStorage key: each chat's (and app home's) Issues view. Per browser. */
export const ISSUE_VIEWS_STORAGE_KEY = 'otherbench.issueViews';

/** The stored views, keeping only well-formed ones. */
export function loadIssueViews(): Record<string, IssueView> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ISSUE_VIEWS_STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const views: Record<string, IssueView> = {};
    for (const [owner, v] of Object.entries(parsed as Record<string, Partial<IssueView> | null>)) {
      if (!v || (v.state !== 'open' && v.state !== 'closed')) continue;
      const selected = typeof v.selected === 'number' && Number.isInteger(v.selected) && v.selected > 0 ? v.selected : null;
      views[owner] = { state: v.state, selected };
    }
    return views;
  } catch {
    return {};
  }
}

function saveIssueViews(views: Record<string, IssueView>): void {
  try {
    window.localStorage.setItem(ISSUE_VIEWS_STORAGE_KEY, JSON.stringify(views));
  } catch {
    // storage blocked or full -- the views still apply for this session.
  }
}

/** localStorage keys: each chat's (and app home's) Deck and Wiki views. Per browser. */
export const DECK_VIEWS_STORAGE_KEY = 'otherbench.deckViews';
export const WIKI_VIEWS_STORAGE_KEY = 'otherbench.wikiViews';

function positiveIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readViewRecord(key: string): [string, Record<string, unknown>][] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed).filter((e): e is [string, Record<string, unknown>] => !!e[1] && typeof e[1] === 'object' && !Array.isArray(e[1]));
  } catch {
    return [];
  }
}

/** The stored Deck views, keeping only well-formed ones. */
export function loadDeckViews(): Record<string, DeckView> {
  const views: Record<string, DeckView> = {};
  for (const [owner, v] of readViewRecord(DECK_VIEWS_STORAGE_KEY)) {
    const raw = v.stackId;
    const stackId = raw === null || raw === 'archived' ? raw : typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
    if (stackId === undefined) continue;
    views[owner] = { stackId, selected: positiveIntOrNull(v.selected) };
  }
  return views;
}

/** The stored Wiki views, keeping only well-formed ones. */
export function loadWikiViews(): Record<string, WikiView> {
  const views: Record<string, WikiView> = {};
  for (const [owner, v] of readViewRecord(WIKI_VIEWS_STORAGE_KEY)) {
    if (!Array.isArray(v.expanded)) continue;
    views[owner] = { expanded: v.expanded.filter((n): n is number => positiveIntOrNull(n) !== null), selected: positiveIntOrNull(v.selected) };
  }
  return views;
}

function saveViews(key: string, views: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(views));
  } catch {
    // storage blocked or full -- the views still apply for this session.
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
  openTab: (chatId) =>
    set((state) => {
      const view = inMode(state, modeOfTab(chatId, state.chats) ?? state.mode);
      return { ...view, overviewOpen: false, ...withPanes(openPaneTab(synced(view), chatId)) };
    }),
  // A closed viewer tab can hand its pane back to its chat, so the active chat follows the pane.
  closeTab: (chatId) => set((state) => withPanes(closePaneTab(synced(state), chatId))),
  moveTab: (chatId, beforeId) => set((state) => ({ paneState: movePaneTab(synced(state), chatId, beforeId) })),
  setLayout: (layout) => set((state) => withPanes(setPaneLayout(synced(state), layout))),
  focusPane: (index) => set((state) => withPanes(focusPaneIn(synced(state), index))),
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
  // Fills the focused pane, or focuses the pane already showing the chat, in the chat's own mode.
  setActiveChatId: (chatId) =>
    set((state) => {
      const view = inMode(state, modeOfTab(chatId, state.chats) ?? state.mode);
      return { ...view, overviewOpen: false, ...withPanes(showChat(synced(view), chatId)) };
    }),
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
    set({
      appPendingApprovals: Object.fromEntries(hello.pendingApprovals.map((p) => [p.requestId, p])),
      appRunningTurns: Object.fromEntries((hello.runningTurns ?? []).map((t) => [t.messageId, t.chatId])),
      computerSessions: Object.fromEntries((hello.computerSessions ?? []).map((c) => [c.chatId, computerSessionOf(c.lastAction)])),
      appBackgroundChats: Object.fromEntries((hello.backgroundChats ?? []).filter((c) => c.count > 0).map((c) => [c.chatId, c.count])),
    }),
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
  setMode: (mode) => set((state) => ({ ...inMode(state, mode), overviewOpen: false })),
  overview: null,
  setOverview: (overview) => set({ overview }),
  overviewOpen: loadOverviewOpen(),
  setOverviewOpen: (open) => set({ overviewOpen: open }),
  openAppHome: (appId) =>
    set((state) => {
      const view = inMode(state, 'code');
      // Shown in the pane, not made a tab: only what the user asks to be a tab becomes one.
      return { ...view, overviewOpen: false, ...withPanes(showChat(synced(view), appTabId(appId))) };
    }),
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
  appPage: null,
  openAppPage: (page) => set({ appPage: page }),
  closeAppPage: () => set({ appPage: null }),
  schedulesPage: null,
  openSchedules: (prefill) => set({ schedulesPage: prefill ? { prefill } : {} }),
  closeSchedules: () => set({ schedulesPage: null }),
  schedulesVersion: 0,
}));

/** How many tool calls are waiting for approval across the whole app (the tray's count: questions and plans aren't counted). */
export const selectPendingApprovalCount = (s: OtherBenchState): number => Object.values(s.appPendingApprovals).filter((p) => p.kind === undefined).length;

// Tabs, layout and panes (each mode's under its own key), the mode, the Code panel's tab and whether the
// inspector is collapsed are remembered on this device; the notes this tab sent, in this tab. A mode switch
// swaps which state is showing, so both are saved again then, each under its mode's key.
useOtherBenchStore.subscribe((state, previous) => {
  const switched = state.mode !== previous.mode;
  if (switched || state.paneState !== previous.paneState) savePaneState(state.paneState, paneStateKey(state.mode));
  if (switched || state.otherPaneState !== previous.otherPaneState) savePaneState(state.otherPaneState, paneStateKey(otherMode(state.mode)));
  if (switched) saveMode(state.mode);
  if (state.overviewOpen !== previous.overviewOpen) saveOverviewOpen(state.overviewOpen);
  if (state.codePanelTab !== previous.codePanelTab) saveCodePanelTab(state.codePanelTab);
  if (state.issueViews !== previous.issueViews) saveIssueViews(state.issueViews);
  if (state.deckViews !== previous.deckViews) saveViews(DECK_VIEWS_STORAGE_KEY, state.deckViews);
  if (state.wikiViews !== previous.wikiViews) saveViews(WIKI_VIEWS_STORAGE_KEY, state.wikiViews);
  if (state.inspectorCollapsed !== previous.inspectorCollapsed) saveInspectorCollapsed(state.inspectorCollapsed);
  if (state.sentNotes !== previous.sentNotes) saveSentNotes(state.sentNotes);
});
