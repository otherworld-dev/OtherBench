import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import type { BackgroundHelper, BackgroundMark, ChatLevelEvent } from '@otherbench/core/types/background.js';
import type { ScheduleTarget } from '@otherbench/core/domain/schedule.js';
import type { TurnEvent } from '@otherbench/core/domain/turn.js';
import type { App, AppFolder, Chat, Project } from '@otherbench/core/ports/store.js';
import type { Connection, ModelInfo, Profile } from '@otherbench/core/types/config.js';
import type { CanonMessage, MessageStatus } from '@otherbench/core/types/messages.js';
import type { NoteOutcome, ReplyNote } from '@otherbench/core/types/notes.js';
import type { AppEvent, AppEventsHello, PendingApprovalSummary } from '@otherbench/core/types/events.js';
import type { RecordedUsage } from '@otherbench/core/types/usage.js';
import type { IssueDetail, IssueSummary } from '@otherbench/core/types/code.js';
import type { Bookmark, DeckBoardView, DeckCardDetail, WikiPage, WikiTree } from '@otherbench/core/types/nextcloud.js';
import type { Overview } from '@otherbench/core/types/overview.js';
import type { DockView } from '../desktop/windows.js';
import type { Mode } from './mode.js';
import type { Layout, PaneState } from './panes.js';
import type { MessageExtras } from './reducer.js';
import type { PeersOverview } from './api.js';

// The store's shape (`OtherBenchState`, created in store.ts) and the types its fields use.

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
  /** Pins pane `index` so nothing opened elsewhere replaces its chat, or unpins it. */
  togglePanePin(index: number): void;
  /** Fills pane `index` even if it's pinned, for when the user chose that pane: a drop on it, or a chat started from the page in it. */
  placeChat(index: number, chatId: string): void;
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
  computerSessions: Record<string, { lastAction?: string; startedFrom?: string }>;
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
  /** Opening it while it is undocked brings its own window forward instead. */
  setOverviewOpen(open: boolean): void;
  /**
   * The views in windows of their own (desktop/windows.ts), as the shell last said. The main window
   * leaves Code mode while Code is undocked and closes the Overview while that is.
   */
  undocked: DockView[];
  setUndocked(views: DockView[]): void;
  /** Shows the app's home (`appTabId`) in the focused pane in Code mode, switching to Code mode first. Not as a tab. */
  openAppHome(appId: string): void;
  /** Shows the All apps page (`ALL_APPS_TAB_ID`) in the focused pane in Code mode, as `openAppHome` shows an app's home. */
  openAllApps(): void;
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
  /**
   * The messages this window has loaded or streamed into, across chats, keyed by id. A chat switch or pane change
   * forgets the chats nobody is looking at past the few viewed last (`pruneMessages`).
   */
  messages: Record<string, CanonMessage>;
  /** Chats shown in this window, most recent first, as far back as the pool keeps them (messagePool.ts). Not persisted. */
  viewedChats: string[];
  /** Forgets the messages (and what hangs off them) of chats not in use past the `KEPT_RECENT_CHATS` viewed last. */
  pruneMessages(): void;
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
   * simply forgotten. Before the chat's messages have loaded (`messagesLoaded`
   * false) a note with no outcome can't be told from one a reply shows was
   * read, so it is held in `unsureNotes` until `settleUnsureNotes`.
   */
  setChatNotes(chatId: string, notes: ReplyNote[], outcomes: { noteId: string; outcome: NoteOutcome }[], messagesLoaded?: boolean): void;
  /** Each chat's notes a hello found lost before its messages loaded, by id: not yet known to be read or not. */
  unsureNotes: Record<string, string[]>;
  /** The chat's messages have loaded (or failed to): its unsure notes still unresolved come back to the box unless a reply shows them read. */
  settleUnsureNotes(chatId: string): void;
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
