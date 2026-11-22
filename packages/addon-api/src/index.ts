/**
 * The add-on API (docs/features/addons.md): what OtherBench gives an add-on, and what an add-on gives back.
 *
 * An add-on is a folder in `<data dir>/addons/<id>/`, copied there by hand on the machine it runs on. It holds
 * `addon.json` (an {@link AddonManifest}) and its built files. At start-up the server imports `main` and calls its
 * `activate` with an {@link AddonHost}, the only thing an add-on is handed. Nothing in OtherBench installs, removes or
 * switches on an add-on.
 *
 * This package holds types and one constant only, so an add-on can build against it without OtherBench's own code.
 */
import type { Context } from 'hono';

/** The host API this OtherBench offers. An add-on whose manifest names another isn't loaded. */
export const ADDON_API_VERSION = 1;

/** `addon.json`. */
export interface AddonManifest {
  /** Lower case letters, digits and dashes, 2 to 32 long, starting with a letter; the same as its folder's name. */
  id: string;
  name: string;
  version: string;
  /** Must be {@link ADDON_API_VERSION}. */
  apiVersion: number;
  /** The ES module to import, relative to the add-on's folder and inside it. */
  main: string;
  /** A folder of static files (with `index.html`) shown under Settings → Add-ons, relative and inside the folder. */
  settingsPage?: string;
  /** The first part of every job branch its jobs make (`<prefix>/<job id>`). Defaults to the id. */
  branchPrefix?: string;
}

export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled';

/** What the agent said is done and left, through its set_chat_status tool. */
export interface AgentStatus {
  done: boolean;
  left: { text: string; who?: 'you' | 'me' | 'parked' }[];
}

/** A job's reply. */
export interface JobReply {
  status: MessageStatus;
  error: string | null;
  text: string;
  chatStatus: AgentStatus | null;
}

/**
 * Job chats (docs/features/jobs.md). Every chat made here runs every turn under OtherBench's job rules, in its folder
 * only, whatever the add-on does; commands run here have their network fixed by OtherBench.
 */
export interface AddonJobRunner {
  /** With `appId` (an id from `apps()`), the chat is in that app, so the Code tab lists it there; it still runs in `folder`. */
  createChat(input: { title: string; folder: string; profileId: string; appId?: string | null }): { chatId: string };
  profile(profileId: string | null): Promise<{ id: string; name: string; archived: boolean } | null>;
  startTurn(input: { chatId: string; text: string; profileId: string }): Promise<{ userMessageId: string; messageId: string }>;
  onReplyEnded(cb: (messageId: string, status: MessageStatus) => void): () => void;
  reply(messageId: string): JobReply | null;
  chatExists(chatId: string): boolean;
  cancel(messageId: string, notice?: string): void;
  closeChat(chatId: string): void;
  refusedCalls(chatId: string, since: number): number;
  runCommand(input: { chatId: string; folder: string; command: string; network: 'install' | 'none'; signal?: AbortSignal }): Promise<{ ok: boolean; summary: string }>;
  uncommitted(chatId: string, folder: string): Promise<{ files: number; summary: string } | null>;
  releaseSandbox(chatId: string): Promise<void>;
}

export interface CommitSummary {
  sha: string;
  subject: string;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  text: string;
}

/** Hardened git for job folders, its branches under the add-on's own prefix (docs/features/jobs.md). */
export interface AddonJobGit {
  readonly branchPrefix: string;
  jobBranchFor(jobId: string): string;
  baseFor(o: { appRepo: string; remote: string; baseBranch: string }): Promise<{ commit: string; fetch: { ok: boolean; note: string } }>;
  cloneForJob(o: { source: string; dest: string; startCommit: string; branch: string }): Promise<{ baseCommit: string }>;
  repoRules(folder: string, commit: string, max?: number): Promise<{ text: string; files: string[]; cut: boolean } | null>;
  headOf(folder: string, branch: string): Promise<string | null>;
  commits(folder: string, base: string, head: string): Promise<CommitSummary[]>;
  diffstat(folder: string, base: string, head: string): Promise<DiffStat>;
  fetchInto(o: { appRepo: string; folder: string; branch: string }): Promise<string>;
  publish(o: { appRepo: string; folder: string; jobId: string; branch: string; headCommit: string; remote: string }): Promise<{ ok: true; already: boolean } | { ok: false; note: string }>;
}

/** What an add-on is handed. */
export interface AddonHost {
  readonly id: string;
  /** The add-on's own folder for its data (a SQLite file, say). */
  readonly dataFolder: string;
  readonly log: (message: string, err?: unknown) => void;
  /** This machine's secret store, under keys only this add-on can reach. */
  readonly secrets: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** This machine's apps, each with its folder here (null when it has none). */
  apps(): { id: string; name: string; folder: string | null }[];
  /** Profiles that aren't archived. */
  profiles(): { id: string; name: string }[];
  defaultProfileId(): string | null;
  machineName(): string;
  readonly jobs: AddonJobRunner;
  readonly git: AddonJobGit;
  /**
   * Its routes, served at `/api/addons/<id>/` behind the same sign-in as the rest of the API, with that prefix taken
   * off the path. A Hono app does; any object with `fetch` will. Call once.
   */
  routes(app: AddonRoutes): void;
  /** True when the request came from this machine (the desktop app, or a server that takes no sign-ins). */
  atThisMachine(c: Context): boolean;
  /** Tells every open window something of this add-on's changed; its settings page re-reads. */
  notify(): void;
  readonly fetch: typeof fetch;
  readonly lookup: (host: string) => Promise<{ address: string; family: number }[]>;
}

/** An add-on's routes: anything that answers a Request, such as a Hono app of its own. */
export interface AddonRoutes {
  fetch(request: Request): Response | Promise<Response>;
}

/** What `main` exports. */
export interface AddonModule {
  activate(host: AddonHost): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
