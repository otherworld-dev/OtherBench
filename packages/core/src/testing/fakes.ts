import { randomUUID } from 'node:crypto';
import type {
  ChatEngine,
  ConnectionTestResult,
  DiscoveredModel,
  EngineEvent,
  EngineRequest,
} from '../ports/chat-engine.js';
import type { Connection } from '../types/config.js';
import type { SecretStore } from '../ports/secret-store.js';
import type {
  ApprovalChoice,
  ApprovalOptions,
  ApprovalOutcome,
  ToolApprovalEvent,
  ToolContext,
  ToolProvider,
  ToolSpec,
} from '../ports/tool-provider.js';
import { runsShellInSandbox, type ToolPolicy } from '../types/config.js';
import type {
  AppSettings,
  Artifact,
  ArtifactRepo,
  ArtifactVersion,
  Attachment,
  AttachmentRepo,
  AuditEntry,
  AuditRepo,
  Chat,
  ChatRepo,
  ConnectionRepo,
  Grant,
  GrantRepo,
  LocationRepo,
  McpServer,
  McpServerRepo,
  MemoryAuthor,
  MessageRepo,
  ModelRepo,
  NewChat,
  NewProject,
  NodeRepo,
  PeerRepo,
  ProfileRepo,
  Project,
  ProjectMemory,
  ProjectMemoryRepo,
  ProjectMemoryVersion,
  GlobalMemory,
  GlobalMemoryRepo,
  GlobalMemoryVersion,
  ProjectRepo,
  SettingsRepo,
  Store,
  UsageRecord,
  UsageRepo,
  NewArtifactVersion,
  ArtifactVersionInfo,
} from '../ports/store.js';
import type { Peer } from '../types/peer.js';
import type { Location, LocationPath, NodeInfo } from '../types/workspace.js';
import { toStoredWorkspace } from '../domain/workspace.js';
import { isDeferrableInAutoMode, PermissionBroker } from '../domain/permissions.js';
import { compareProjects } from '../domain/projects.js';
import { MEMORY_VERSIONS_KEPT } from '../domain/memory.js';
import { DEFAULT_APP_SETTINGS } from '../domain/settings.js';
import { SandboxError, type Sandbox, type SandboxRunRequest, type SandboxRunResult, type SandboxStatus, type SandboxVersions } from '../ports/sandbox.js';
import { toSandboxPath } from '../domain/sandbox-paths.js';
import type { ModelInfo, Profile } from '../types/config.js';
import type { CanonMessage, EngineMeta, MessageStatus, Part, SerializedError } from '../types/messages.js';

// ---------------------------------------------------------------------------
// FakeChatEngine
// ---------------------------------------------------------------------------

/**
 * Either a fixed sequence of events (same for every request), or a function
 * that computes the sequence from the request just received -- so a test
 * can make the "model" behave differently per profile/connection/messages.
 */
export type EngineScript = EngineEvent[] | ((req: EngineRequest) => EngineEvent[]);

/**
 * A scriptable `ChatEngine` test double. Every request it receives is
 * appended to `.requests` (in call order, by reference -- so a test can
 * assert on exactly what was sent to "the model", e.g. that an image part
 * was converted to a text placeholder before reaching here) and then
 * replayed against `script` to decide what to yield.
 *
 * Honours `req.signal`: the abort state is checked immediately before each
 * event would be yielded, so an abort between two `.next()` calls stops the
 * stream from yielding anything further (including one already "queued" in
 * the script) -- and a signal that is already aborted before iteration
 * starts yields nothing at all.
 */
export class FakeChatEngine implements ChatEngine {
  readonly requests: EngineRequest[] = [];

  /** Models `listModels` returns; override per-test as needed. */
  models: DiscoveredModel[] = [];

  /** Result `testConnection` returns; override per-test as needed. */
  connectionTestResult: ConnectionTestResult = { ok: true, message: 'ok', latencyMs: 0 };

  constructor(private readonly script: EngineScript) {}

  async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
    this.requests.push(req);
    const events = typeof this.script === 'function' ? this.script(req) : this.script;
    for (const event of events) {
      if (req.signal.aborted) return;
      yield event;
    }
  }

  async listModels(_conn: Connection, _apiKey: string | null): Promise<DiscoveredModel[]> {
    return this.models;
  }

  async testConnection(_conn: Connection, _apiKey: string | null): Promise<ConnectionTestResult> {
    return this.connectionTestResult;
  }
}

// ---------------------------------------------------------------------------
// FakeSecretStore
// ---------------------------------------------------------------------------

/** A `SecretStore` test double backed by a plain `Map`. No encryption, no I/O. */
export class FakeSecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async get(ref: string): Promise<string | null> {
    return this.secrets.get(ref) ?? null;
  }

  async set(ref: string, value: string): Promise<void> {
    this.secrets.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    this.secrets.delete(ref);
  }
}

// ---------------------------------------------------------------------------
// FakeSandbox
// ---------------------------------------------------------------------------

export interface FakeSandboxOptions {
  /** Start ready, as if set up. Default: not set up, like a fresh machine. */
  ready?: boolean;
  /** This machine's name, for the "isn't set up on <machine>" refusal. */
  machine?: () => string;
  /** Hosts every run asks about (through `req.askHost`) before it finishes. */
  askHosts?: { host: string; port?: number }[];
  /** Changes to the result a run returns. */
  result?: (req: SandboxRunRequest) => Partial<SandboxRunResult>;
}

export const FAKE_SANDBOX_VERSIONS: SandboxVersions = { distro: 'Fake Linux 1.0', runtime: '0.0.79', node: 'v24.21.0' };

function fakeSandboxCwd(root: string): string {
  try {
    return toSandboxPath(root);
  } catch {
    return root;
  }
}

/**
 * A `Sandbox` test double, and the e2e server's (GRUNT_SANDBOX=fake): records
 * every request, runs nothing, and answers like a sandbox that worked.
 */
export class FakeSandbox implements Sandbox {
  readonly requests: SandboxRunRequest[] = [];
  readonly released: string[] = [];
  readonly asked: { host: string; port: number | undefined; allowed: boolean }[] = [];
  setupCalls = 0;
  closed = false;
  private state: 'not_set_up' | 'ready';
  private packages: string[] = [];
  private readonly machine: () => string;

  constructor(private readonly options: FakeSandboxOptions = {}) {
    this.state = options.ready === true ? 'ready' : 'not_set_up';
    this.machine = options.machine ?? (() => 'This machine');
  }

  async status(): Promise<SandboxStatus> {
    const base = { packages: [...this.packages], machine: this.machine() };
    return this.state === 'ready' ? { state: 'ready', versions: { ...FAKE_SANDBOX_VERSIONS }, ...base } : { state: 'not_set_up', ...base };
  }

  async setup(): Promise<void> {
    this.setupCalls += 1;
    this.state = 'ready';
  }

  async remove(): Promise<void> {
    this.state = 'not_set_up';
  }

  async setPackages(packages: string[]): Promise<void> {
    this.packages = [...packages];
  }

  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    this.requests.push(req);
    if (this.state !== 'ready') throw new SandboxError('not_set_up', `The sandbox isn't set up on ${this.machine()}.`);
    for (const { host, port } of this.options.askHosts ?? []) {
      const allowed = await req.askHost(host, port);
      this.asked.push({ host, port, allowed });
    }
    return {
      command: req.command,
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      timeoutMsUsed: req.timeoutMs,
      output: `fake sandbox ran: ${req.command}\n`,
      sandbox: true,
      cwd: fakeSandboxCwd(req.workspaceRoot),
      ...this.options.result?.(req),
    };
  }

  async release(chatId: string): Promise<void> {
    this.released.push(chatId);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// FakeToolProvider
// ---------------------------------------------------------------------------

function stubTool(name: string, risk: ToolSpec['risk'], source: ToolSpec['source']): ToolSpec {
  return {
    name,
    description: `${name} (fake)`,
    parameters: { type: 'object', properties: {} },
    risk,
    source,
    execute: async () => ({ ok: true }),
  };
}

/** An MCP server the fake should expose, in the same shape the shared contract describes. */
export interface FakeMcpServer {
  id: string;
  name: string;
  tools: { name: string; readOnly?: boolean }[];
}

export interface FakeToolProviderOptions {
  /** Built-in (fs/shell) tools. Defaults to one read fs tool, one mutate fs tool, the host shell tool and the sandboxed one. */
  tools?: ToolSpec[];
  /** MCP servers whose tools are offered when the policy enables their id. */
  mcpServers?: FakeMcpServer[];
}

/**
 * A `ToolProvider` test double. It deliberately does NOT re-implement the
 * permission rules: every decision is made by a real `PermissionBroker` over a
 * private `InMemoryStore`, exactly as `GruntToolProvider` does, so the fake
 * cannot drift from the real policy / grant / auto-approve / ask semantics.
 * What it does mirror (and what the shared contract in
 * tool-provider-contract.ts pins) is the provider's own orchestration: policy-
 * filtered listing, `mcp__<server>__<tool>` namespacing with `_2`, `_3`...
 * de-duplication, the gate that turns a denial into a tool-error result, and the
 * approval request -> `resolveApproval` / abort -> resolved lifecycle (including
 * Claude Code auto mode's `deferAsk`). Tool bodies are stubs that return
 * `{ ok: true }` (MCP stubs return a text content array); nothing touches disk.
 */
/** What GruntToolProvider returns when a turn ends before a call is authorised. */
const FAKE_CANCELLED = {
  ok: false as const,
  code: 'cancelled' as const,
  reason: 'The turn was stopped before this tool call was approved, so it did not run. Nobody denied it.',
};

export class FakeToolProvider implements ToolProvider {
  readonly refreshed: string[] = [];
  readonly denials: { toolName: string; reason: string }[] = [];
  shutdownCalls = 0;
  private readonly listeners = new Set<(event: ToolApprovalEvent) => void>();
  private readonly waiters = new Map<string, (choice: ApprovalChoice) => void>();
  private readonly broker: PermissionBroker;
  private readonly tools: ToolSpec[];
  private readonly mcpServers: FakeMcpServer[];

  constructor(options: FakeToolProviderOptions = {}) {
    this.broker = new PermissionBroker(new InMemoryStore());
    this.tools = options.tools ?? [
      stubTool('read_file', 'read', 'fs'),
      stubTool('write_file', 'mutate', 'fs'),
      stubTool('run_command', 'execute', 'shell'),
      stubTool('run_command', 'execute', 'sandbox'),
    ];
    this.mcpServers = options.mcpServers ?? [];
  }

  async listTools(policy: ToolPolicy): Promise<ToolSpec[]> {
    const raw: ToolSpec[] = [];
    if (policy.fs === 'readwrite') raw.push(...this.tools.filter((t) => t.source === 'fs'));
    else if (policy.fs === 'read') raw.push(...this.tools.filter((t) => t.source === 'fs' && t.risk === 'read'));
    // One run_command, never both: the sandboxed one when the shell runs there.
    if (policy.shell) raw.push(...this.tools.filter((t) => t.source === (runsShellInSandbox(policy) ? 'sandbox' : 'shell')));
    if (policy.artifacts !== false) raw.push(...this.tools.filter((t) => t.source === 'artifact'));
    if (policy.recall !== false) raw.push(...this.tools.filter((t) => t.source === 'recall'));
    for (const id of policy.mcpServerIds) {
      const server = this.mcpServers.find((s) => s.id === id);
      if (!server) continue;
      for (const tool of server.tools) {
        raw.push({
          name: `mcp__${server.name}__${tool.name}`,
          description: tool.name,
          parameters: { type: 'object', properties: {} },
          risk: tool.readOnly === true ? 'read' : 'mutate',
          source: 'mcp',
          serverId: server.id,
          execute: async () => [{ type: 'text', text: 'ok' }],
        });
      }
    }
    const seen = new Map<string, number>();
    const unique = raw.map((spec) => {
      const prior = seen.get(spec.name) ?? 0;
      seen.set(spec.name, prior + 1);
      return prior === 0 ? spec : { ...spec, name: `${spec.name}_${prior + 1}` };
    });
    return unique.map((spec) => this.gate(spec, policy));
  }

  async refreshMcp(serverId: string): Promise<void> {
    this.refreshed.push(serverId);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }

  onApprovalEvent(cb: (event: ToolApprovalEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  resolveApproval(requestId: string, choice: ApprovalChoice): boolean {
    const settle = this.waiters.get(requestId);
    if (!settle) return false;
    settle(choice);
    return true;
  }

  async requestApproval(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext, opts: ApprovalOptions = {}): Promise<ApprovalOutcome> {
    const decision = this.broker.decide(tool, args, policy, ctx);
    if (decision.kind === 'ask' && opts.deferAsk === true && isDeferrableInAutoMode(tool, args)) {
      this.broker.discard(decision.request.id);
      return { deferred: true };
    }
    const auth = await this.settle(decision, ctx);
    return auth.ok ? { allowed: true, grantedBy: auth.grantedBy } : { allowed: false, reason: auth.reason };
  }

  recordAgentDenial(_ctx: ToolContext, toolName: string, _args: unknown, reason: string): void {
    this.denials.push({ toolName, reason });
  }

  private gate(tool: ToolSpec, policy: ToolPolicy): ToolSpec {
    return {
      ...tool,
      execute: async (args: unknown, ctx: ToolContext): Promise<unknown> => {
        // Mirrors GruntToolProvider: a call that arrives after its turn ended
        // never runs, even when a grant or policy would allow it.
        const auth = ctx.signal.aborted ? FAKE_CANCELLED : await this.settle(this.broker.decide(tool, args, policy, ctx), ctx);
        if (!auth.ok) return { error: true, code: auth.code, message: auth.reason };
        return tool.execute(args, ctx);
      },
    };
  }

  private async settle(
    decision: ReturnType<PermissionBroker['decide']>,
    ctx: ToolContext
  ): Promise<{ ok: true; grantedBy: string } | { ok: false; code: 'permission_denied' | 'approval_denied' | 'cancelled'; reason: string }> {
    if (decision.kind === 'deny') return { ok: false, code: 'permission_denied', reason: decision.reason };
    if (decision.kind === 'allow') return { ok: true, grantedBy: decision.grantId ? `${decision.grantedBy}:${decision.grantId}` : decision.grantedBy };

    const { request } = decision;
    // The turn already ended: nobody can answer, so drop the request and raise no card.
    if (ctx.signal.aborted) {
      this.broker.discard(request.id);
      return FAKE_CANCELLED;
    }
    // Waiter registered BEFORE notifying so a listener may answer synchronously.
    const pending = new Promise<{ choice: ApprovalChoice; cancelled: boolean }>((resolve) => {
      let done = false;
      const settleChoice = (choice: ApprovalChoice, cancelled = false): void => {
        if (done) return;
        done = true;
        ctx.signal.removeEventListener('abort', onAbort);
        this.waiters.delete(request.id);
        this.broker.resolve(request.id, choice);
        resolve({ choice, cancelled });
      };
      const onAbort = (): void => settleChoice({ choice: 'deny' }, true);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(request.id, (choice: ApprovalChoice) => settleChoice(choice));
    });
    this.notify({ type: 'request', request });
    const { choice, cancelled } = await pending;
    this.notify({ type: 'resolved', requestId: request.id, messageId: request.messageId, choice: choice.choice });
    if (cancelled) return FAKE_CANCELLED;
    if (choice.choice === 'deny') return { ok: false, code: 'approval_denied', reason: 'The user denied this tool call.' };
    return { ok: true, grantedBy: `ask:${choice.choice}` };
  }

  private notify(event: ToolApprovalEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        /* a listener throwing must not break the gate */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// InMemoryStore
// ---------------------------------------------------------------------------
//
// Behavioural policy shared by every repo below, chosen so it is equally
// natural for a real SQL adapter (Task 9) to replicate -- the point of the
// shared contract suite in store-contract.ts is that this fake and the real
// adapter are held to the identical suite, so drift here would be drift
// there too:
//
//   - create(): throws on a duplicate id (mirrors a PRIMARY KEY / UNIQUE
//     constraint violation on INSERT).
//   - get() / list() / children() / roots(): return null / [] for an
//     unknown id rather than throwing (mirrors a SELECT that simply
//     matches zero rows).
//   - update() / updateParts() / updateStatus(): throw if the id doesn't
//     exist (mirrors checking the affected-row count after an UPDATE and
//     raising if it was zero -- the return type is a non-nullable entity,
//     so silently no-op-ing would have nothing valid to return).
//   - delete(): a no-op if the id doesn't exist (mirrors a DELETE ... WHERE
///    id = ? that simply affects zero rows; idempotent by construction).
//   - pathToRoot(): returns [] for an unknown id (mirrors a recursive CTE
//     whose anchor member matches no rows).

/** Generic in-memory CRUD storage shared by the simple (non-tree) repos below. */
class InMemoryCrudRepo<T extends { id: string }> {
  private readonly rows = new Map<string, T>();

  create(item: T): T {
    if (this.rows.has(item.id)) {
      throw new Error(`Duplicate id: ${item.id}`);
    }
    this.rows.set(item.id, structuredClone(item));
    return structuredClone(item);
  }

  get(id: string): T | null {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  list(): T[] {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }

  update(id: string, patch: Partial<Omit<T, 'id'>>): T {
    const current = this.rows.get(id);
    if (!current) {
      throw new Error(`Not found: ${id}`);
    }
    const updated = { ...current, ...patch } as T;
    this.rows.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  delete(id: string): void {
    this.rows.delete(id);
  }
}

class InMemoryConnectionRepo implements ConnectionRepo {
  private readonly repo = new InMemoryCrudRepo<Connection>();
  create(c: Connection): Connection {
    return this.repo.create(c);
  }
  get(id: string): Connection | null {
    return this.repo.get(id);
  }
  list(): Connection[] {
    return this.repo.list();
  }
  update(id: string, patch: Partial<Omit<Connection, 'id'>>): Connection {
    return this.repo.update(id, patch);
  }
  delete(id: string): void {
    this.repo.delete(id);
  }
}

class InMemoryModelRepo implements ModelRepo {
  private readonly repo = new InMemoryCrudRepo<ModelInfo>();
  create(m: ModelInfo): ModelInfo {
    return this.repo.create(m);
  }
  get(id: string): ModelInfo | null {
    return this.repo.get(id);
  }
  list(connectionId?: string): ModelInfo[] {
    const all = this.repo.list();
    return connectionId ? all.filter((m) => m.connectionId === connectionId) : all;
  }
  update(id: string, patch: Partial<Omit<ModelInfo, 'id'>>): ModelInfo {
    return this.repo.update(id, patch);
  }
  delete(id: string): void {
    this.repo.delete(id);
  }
}

class InMemoryProfileRepo implements ProfileRepo {
  private readonly repo = new InMemoryCrudRepo<Profile>();
  constructor(private readonly projects: ProjectRepo) {}
  create(p: Profile): Profile {
    return this.repo.create({ ...p, useGlobalMemory: p.useGlobalMemory ?? true });
  }
  get(id: string): Profile | null {
    return this.repo.get(id);
  }
  list(): Profile[] {
    return this.repo.list();
  }
  update(id: string, patch: Partial<Omit<Profile, 'id'>>): Profile {
    return this.repo.update(id, patch);
  }
  delete(id: string): void {
    // Mirrors project.default_profile_id's ON DELETE SET NULL (migration 007).
    for (const project of this.projects.list()) {
      if (project.defaultProfileId === id) this.projects.update(project.id, { defaultProfileId: null });
    }
    this.repo.delete(id);
  }
}

class InMemoryNodeRepo implements NodeRepo {
  private node: NodeInfo;
  constructor(id: string) {
    this.node = { id, name: 'This machine' };
  }
  self(): NodeInfo {
    return { ...this.node };
  }
  rename(name: string): NodeInfo {
    this.node = { ...this.node, name };
    return { ...this.node };
  }
}

class InMemoryLocationRepo implements LocationRepo {
  private readonly repo = new InMemoryCrudRepo<Location>();
  private pathRows: LocationPath[] = [];
  constructor(private readonly onDelete: (locationId: string) => void) {}
  list(): Location[] {
    return this.repo.list().sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }
  get(id: string): Location | null {
    return this.repo.get(id);
  }
  create(l: Location): Location {
    return this.repo.create(l);
  }
  update(id: string, patch: Partial<Omit<Location, 'id'>>): Location {
    return this.repo.update(id, patch);
  }
  delete(id: string): void {
    this.repo.delete(id);
    this.pathRows = this.pathRows.filter((p) => p.locationId !== id);
    this.onDelete(id);
  }
  allPaths(): LocationPath[] {
    return this.pathRows.map((p) => ({ ...p }));
  }
  paths(locationId: string): LocationPath[] {
    return this.pathRows.filter((p) => p.locationId === locationId).map((p) => ({ ...p }));
  }
  pathsForNode(nodeId: string): LocationPath[] {
    return this.pathRows.filter((p) => p.nodeId === nodeId).map((p) => ({ ...p }));
  }
  setPath(p: LocationPath): LocationPath {
    if (!this.repo.get(p.locationId)) throw new Error(`location: not found: ${p.locationId}`);
    this.pathRows = [...this.pathRows.filter((r) => !(r.locationId === p.locationId && r.nodeId === p.nodeId)), { ...p }];
    return { ...p };
  }
  deletePath(locationId: string, nodeId: string): void {
    this.pathRows = this.pathRows.filter((r) => !(r.locationId === locationId && r.nodeId === nodeId));
  }
}

class InMemoryPeerRepo implements PeerRepo {
  private readonly byId = new Map<string, Peer>();
  list(): Peer[] {
    return [...this.byId.values()].sort((a, b) => a.pairedAt - b.pairedAt || (a.nodeId < b.nodeId ? -1 : 1)).map((p) => structuredClone(p));
  }
  get(nodeId: string): Peer | null {
    const p = this.byId.get(nodeId);
    return p ? structuredClone(p) : null;
  }
  getByFingerprint(fingerprint: string): Peer | null {
    const p = [...this.byId.values()].find((x) => x.fingerprint === fingerprint);
    return p ? structuredClone(p) : null;
  }
  create(p: Peer): Peer {
    if (this.byId.has(p.nodeId)) throw new Error(`peer: duplicate node id: ${p.nodeId}`);
    if (this.getByFingerprint(p.fingerprint)) throw new Error(`peer: duplicate fingerprint: ${p.fingerprint}`);
    this.byId.set(p.nodeId, structuredClone(p));
    return structuredClone(p);
  }
  update(nodeId: string, patch: Partial<Omit<Peer, 'nodeId'>>): Peer {
    const current = this.byId.get(nodeId);
    if (!current) throw new Error(`peer: not found: ${nodeId}`);
    const next = { ...current, ...structuredClone(patch), nodeId };
    this.byId.set(nodeId, next);
    return structuredClone(next);
  }
  delete(nodeId: string): void {
    this.byId.delete(nodeId);
  }
}

class InMemoryChatRepo implements ChatRepo {
  private readonly repo = new InMemoryCrudRepo<Chat>();
  constructor(private readonly selfNodeId: string) {}
  /** A deleted location takes its chats' folders with it (the SQL schema's ON DELETE SET NULL). */
  clearLocation(locationId: string): void {
    for (const chat of this.repo.list()) {
      if (chat.workspace?.kind === 'location' && chat.workspace.locationId === locationId) this.repo.update(chat.id, { workspace: null });
    }
  }
  create(c: NewChat): Chat {
    const now = Date.now();
    const fields = toStoredWorkspace(c, this.selfNodeId);
    const full: Chat = {
      ...fields,
      workspace: fields.workspace ?? null,
      runsOn: c.runsOn ?? this.selfNodeId,
      autoMode: c.autoMode ?? false,
      projectId: c.projectId ?? null,
      memoryCursor: c.memoryCursor ?? null,
      memoryExcluded: c.memoryExcluded ?? false,
      projectPinned: c.projectPinned ?? false,
      globalMemoryCursor: c.globalMemoryCursor ?? null,
      sortOrder: c.sortOrder ?? c.createdAt ?? now,
      createdAt: c.createdAt ?? now,
      updatedAt: c.updatedAt ?? now,
    };
    return this.repo.create(full);
  }
  get(id: string): Chat | null {
    return this.repo.get(id);
  }
  list(): Chat[] {
    return this.repo.list();
  }
  update(id: string, patch: Partial<Omit<Chat, 'id'>>): Chat {
    // A chat that changes project starts over in the new project's memory (ChatRepo.update's doc).
    const current = this.repo.get(id);
    const stored = toStoredWorkspace(patch, this.selfNodeId) as Partial<Omit<Chat, 'id'>>;
    const moved = current !== null && stored.projectId !== undefined && stored.projectId !== current.projectId;
    return this.repo.update(id, moved ? { ...stored, memoryCursor: null, projectPinned: stored.projectPinned ?? false } : stored);
  }
  delete(id: string): void {
    this.repo.delete(id);
  }
}

class InMemoryProjectRepo implements ProjectRepo {
  private readonly repo = new InMemoryCrudRepo<Project>();
  constructor(
    private readonly chats: ChatRepo,
    private readonly onDelete: (projectId: string) => void,
    private readonly selfNodeId: string
  ) {}
  create(p: NewProject): Project {
    const now = Date.now();
    const fields = toStoredWorkspace(p, this.selfNodeId);
    return this.repo.create({
      ...fields,
      workspace: fields.workspace ?? null,
      description: p.description ?? '',
      instructions: p.instructions ?? '',
      sortOrder: p.sortOrder ?? 0,
      createdAt: p.createdAt ?? now,
      updatedAt: p.updatedAt ?? now,
    });
  }
  /** A deleted location takes its projects' folders with it, as for chats. */
  clearLocation(locationId: string): void {
    for (const p of this.repo.list()) {
      if (p.workspace?.kind === 'location' && p.workspace.locationId === locationId) this.repo.update(p.id, { workspace: null });
    }
  }
  get(id: string): Project | null {
    return this.repo.get(id);
  }
  list(): Project[] {
    return this.repo.list().sort(compareProjects);
  }
  update(id: string, patch: Partial<Omit<Project, 'id'>>): Project {
    return this.repo.update(id, toStoredWorkspace(patch, this.selfNodeId));
  }
  delete(id: string): void {
    // Mirrors chat.project_id's ON DELETE SET NULL (migration 007); the chat
    // repo's update also resets each chat's memory cursor.
    for (const chat of this.chats.list()) {
      if (chat.projectId === id) this.chats.update(chat.id, { projectId: null });
    }
    // Mirrors project_memory's and project_memory_version's ON DELETE CASCADE (migration 008).
    this.onDelete(id);
    this.repo.delete(id);
  }
}

/** Versions newest first; ties on `createdAt` break by save order (SQLite: rowid). */
function newestFirst<T extends { createdAt: number }>(versions: T[]): T[] {
  return versions
    .map((v, order) => ({ v, order }))
    .sort((a, b) => b.v.createdAt - a.v.createdAt || b.order - a.order)
    .map(({ v }) => v);
}

class InMemoryProjectMemoryRepo implements ProjectMemoryRepo {
  private readonly notes = new Map<string, ProjectMemory>();
  /** Every project's versions, oldest save first. */
  private all: ProjectMemoryVersion[] = [];

  constructor(private readonly projectExists: (projectId: string) => boolean) {}

  get(projectId: string): ProjectMemory | null {
    const note = this.notes.get(projectId);
    return note ? structuredClone(note) : null;
  }

  save(projectId: string, body: string, by: MemoryAuthor, sourceChatId: string | null, at: number = Date.now()): ProjectMemory {
    // Mirrors project_memory.project_id's foreign key.
    if (!this.projectExists(projectId)) throw new Error(`project_memory: no project ${projectId}`);
    const note: ProjectMemory = { projectId, body, updatedAt: at, updatedBy: by, sourceChatId };
    this.notes.set(projectId, note);
    this.all.push({ id: randomUUID(), projectId, body, createdAt: at, createdBy: by, sourceChatId });
    const keep = new Set(newestFirst(this.all.filter((v) => v.projectId === projectId)).slice(0, MEMORY_VERSIONS_KEPT).map((v) => v.id));
    this.all = this.all.filter((v) => v.projectId !== projectId || keep.has(v.id));
    return structuredClone(note);
  }

  versions(projectId: string): ProjectMemoryVersion[] {
    return newestFirst(this.all.filter((v) => v.projectId === projectId)).map((v) => structuredClone(v));
  }

  version(id: string): ProjectMemoryVersion | null {
    const found = this.all.find((v) => v.id === id);
    return found ? structuredClone(found) : null;
  }

  /** Called by `InMemoryProjectRepo.delete`. */
  removeProject(projectId: string): void {
    this.notes.delete(projectId);
    this.all = this.all.filter((v) => v.projectId !== projectId);
  }
}

/** Mirrors SqliteGlobalMemoryRepo: About you and the note are kept apart; only the note has versions. */
class InMemoryGlobalMemoryRepo implements GlobalMemoryRepo {
  private value: GlobalMemory = { about: '', aboutUpdatedAt: 0, note: '', noteUpdatedAt: 0, noteUpdatedBy: 'user', noteSourceChatId: null };
  /** Oldest save first. */
  private all: GlobalMemoryVersion[] = [];

  get(): GlobalMemory {
    return structuredClone(this.value);
  }

  saveAbout(about: string, at: number = Date.now()): GlobalMemory {
    this.value = { ...this.value, about, aboutUpdatedAt: at };
    return this.get();
  }

  saveNote(body: string, by: MemoryAuthor, sourceChatId: string | null, at: number = Date.now()): GlobalMemory {
    this.value = { ...this.value, note: body, noteUpdatedAt: at, noteUpdatedBy: by, noteSourceChatId: sourceChatId };
    this.all.push({ id: randomUUID(), body, createdAt: at, createdBy: by, sourceChatId });
    const keep = new Set(newestFirst(this.all).slice(0, MEMORY_VERSIONS_KEPT).map((v) => v.id));
    this.all = this.all.filter((v) => keep.has(v.id));
    return this.get();
  }

  versions(): GlobalMemoryVersion[] {
    return newestFirst(this.all).map((v) => structuredClone(v));
  }

  version(id: string): GlobalMemoryVersion | null {
    const found = this.all.find((v) => v.id === id);
    return found ? structuredClone(found) : null;
  }
}

class InMemorySettingsRepo implements SettingsRepo {
  private value: AppSettings = { ...DEFAULT_APP_SETTINGS };
  /** JSON text, so a caller can't change a stored value through the object it passed in. */
  private readonly values = new Map<string, string>();
  get(): AppSettings {
    return { ...this.value };
  }
  update(patch: Partial<AppSettings>): AppSettings {
    for (const [key, value] of Object.entries(patch) as [keyof AppSettings, AppSettings[keyof AppSettings] | undefined][]) {
      if (value !== undefined) this.value = { ...this.value, [key]: value };
    }
    return this.get();
  }
  getValue(key: string): unknown {
    const text = this.values.get(key);
    return text === undefined ? null : (JSON.parse(text) as unknown);
  }
  setValue(key: string, value: unknown): void {
    if (Object.hasOwn(DEFAULT_APP_SETTINGS, key)) throw new Error(`"${key}" is a settings key: change it with update().`);
    if (value === null || value === undefined) this.values.delete(key);
    else this.values.set(key, JSON.stringify(value));
  }
}

class InMemoryAttachmentRepo implements AttachmentRepo {
  private readonly repo = new InMemoryCrudRepo<Attachment>();
  create(a: Attachment): Attachment {
    return this.repo.create(a);
  }
  get(id: string): Attachment | null {
    return this.repo.get(id);
  }
  list(chatId: string): Attachment[] {
    return this.repo.list().filter((a) => a.chatId === chatId);
  }
  update(id: string, patch: Partial<Omit<Attachment, 'id'>>): Attachment {
    return this.repo.update(id, patch);
  }
  delete(id: string): void {
    this.repo.delete(id);
  }
  isReferenced(sha256: string): boolean {
    return this.repo.list().some((a) => a.sha256 === sha256);
  }
  referencedShas(): Set<string> {
    return new Set(this.repo.list().map((a) => a.sha256));
  }
}

class InMemoryUsageRepo implements UsageRepo {
  private readonly repo = new InMemoryCrudRepo<UsageRecord>();
  create(u: UsageRecord): UsageRecord {
    return this.repo.create(u);
  }
  get(id: string): UsageRecord | null {
    return this.repo.get(id);
  }
  list(chatId: string): UsageRecord[] {
    return this.repo.list().filter((u) => u.chatId === chatId);
  }
  update(id: string, patch: Partial<Omit<UsageRecord, 'id'>>): UsageRecord {
    return this.repo.update(id, patch);
  }
  delete(id: string): void {
    this.repo.delete(id);
  }
}

class InMemoryMcpServerRepo implements McpServerRepo {
  private readonly repo = new InMemoryCrudRepo<McpServer>();
  create(s: McpServer): McpServer {
    return this.repo.create(s);
  }
  get(id: string): McpServer | null {
    return this.repo.get(id);
  }
  list(): McpServer[] {
    return this.repo.list();
  }
  update(id: string, patch: Partial<Omit<McpServer, 'id'>>): McpServer {
    return this.repo.update(id, patch);
  }
  delete(id: string): void {
    this.repo.delete(id);
  }
}

class InMemoryGrantRepo implements GrantRepo {
  private readonly repo = new InMemoryCrudRepo<Grant>();
  create(g: Grant): Grant {
    return this.repo.create(g);
  }
  get(id: string): Grant | null {
    return this.repo.get(id);
  }
  list(chatId?: string): Grant[] {
    const all = this.repo.list();
    return chatId ? all.filter((g) => g.chatId === chatId) : all;
  }
  update(id: string, patch: Partial<Omit<Grant, 'id'>>): Grant {
    return this.repo.update(id, patch);
  }
  delete(id: string): void {
    this.repo.delete(id);
  }
}

class InMemoryAuditRepo implements AuditRepo {
  private readonly repo = new InMemoryCrudRepo<AuditEntry>();
  constructor(private readonly selfNodeId: string) {}
  create(a: Omit<AuditEntry, 'createdAt'> & { createdAt?: number }): AuditEntry {
    const full: AuditEntry = { ...a, decidedOnNode: a.decidedOnNode ?? this.selfNodeId, createdAt: a.createdAt ?? Date.now() };
    return this.repo.create(full);
  }
  get(id: string): AuditEntry | null {
    return this.repo.get(id);
  }
  list(chatId: string): AuditEntry[] {
    return this.repo.list().filter((a) => a.chatId === chatId);
  }
  update(id: string, patch: Partial<Omit<AuditEntry, 'id'>>): AuditEntry {
    return this.repo.update(id, patch);
  }
  delete(id: string): void {
    this.repo.delete(id);
  }
}

/**
 * Messages form a tree (one user turn can have several assistant replies),
 * so this repo is not a thin wrapper over `InMemoryCrudRepo` like the others
 * -- it needs parent/child traversal, not just id lookup.
 */
/**
 * Hard cap on how many ancestor hops `pathToRoot` will follow -- kept in
 * step with `MAX_PATH_DEPTH` in packages/store-sqlite/src/repos/messages.ts
 * (see that constant's comment for the full reasoning). `create()` below
 * rejects the one cycle vector it can prevent (`parentId === id`), but nothing
 * stops a caller from mutating `byId` directly (tests do this deliberately
 * to exercise the cap) to build a longer cycle, and this fake's `pathToRoot`
 * used to walk parent links with an unbounded `while`, exactly like the
 * unbounded recursive CTE this mirrors -- so it needs the same backstop or
 * the fake and the real adapter diverge on the fix.
 */
const MAX_PATH_DEPTH = 10_000;

class InMemoryMessageRepo implements MessageRepo {
  private readonly byId = new Map<string, CanonMessage>();
  constructor(private readonly selfNodeId: string) {}

  create(m: Omit<CanonMessage, 'createdAt'> & { createdAt?: number }): CanonMessage {
    if (this.byId.has(m.id)) {
      throw new Error(`Duplicate id: ${m.id}`);
    }
    if (m.parentId === m.id) {
      throw new Error(`message: parentId cannot equal id (self-referencing message): ${m.id}`);
    }
    const full: CanonMessage = { ...m, originNode: m.originNode ?? this.selfNodeId, createdAt: m.createdAt ?? Date.now() };
    this.byId.set(full.id, structuredClone(full));
    return structuredClone(full);
  }

  get(id: string): CanonMessage | null {
    const m = this.byId.get(id);
    return m ? structuredClone(m) : null;
  }

  // `id` breaks ties so that messages sharing a createdAt (same-millisecond
  // inserts, which a compare turn produces routinely) still come back in a
  // stable, deterministic order rather than whichever order they happen to
  // sit in `byId` -- this mirrors SqliteMessageRepo's `ORDER BY created_at
  // ASC, id ASC` (packages/store-sqlite/src/repos/messages.ts).
  children(parentId: string): CanonMessage[] {
    return [...this.byId.values()]
      .filter((m) => m.parentId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((m) => structuredClone(m));
  }

  roots(chatId: string): CanonMessage[] {
    return [...this.byId.values()]
      .filter((m) => m.chatId === chatId && m.parentId === null)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((m) => structuredClone(m));
  }

  pathToRoot(messageId: string): CanonMessage[] {
    const path: CanonMessage[] = [];
    let current = this.byId.get(messageId);
    let depth = 0;
    while (current && depth <= MAX_PATH_DEPTH) {
      path.push(structuredClone(current));
      current = current.parentId === null ? undefined : this.byId.get(current.parentId);
      depth++;
    }
    return path.reverse();
  }

  updateParts(id: string, parts: Part[]): void {
    const m = this.byId.get(id);
    if (!m) {
      throw new Error(`Not found: ${id}`);
    }
    m.parts = structuredClone(parts);
  }

  updateStatus(id: string, status: MessageStatus, error: SerializedError | null = null): void {
    const m = this.byId.get(id);
    if (!m) {
      throw new Error(`Not found: ${id}`);
    }
    m.status = status;
    m.error = error ? structuredClone(error) : null;
  }

  listByStatus(status: MessageStatus): CanonMessage[] {
    return [...this.byId.values()].filter((m) => m.status === status).map((m) => structuredClone(m));
  }

  updateEngineMeta(id: string, meta: EngineMeta): void {
    const m = this.byId.get(id);
    if (!m) {
      throw new Error(`Not found: ${id}`);
    }
    m.engineMeta = structuredClone(meta);
  }

  markKept(id: string, at: number): void {
    const m = this.byId.get(id);
    if (!m) {
      throw new Error(`Not found: ${id}`);
    }
    m.keptAt = at;
  }

  latestBySession(chatId: string, sessionId: string): CanonMessage | null {
    const matches = [...this.byId.values()]
      .filter((m) => m.chatId === chatId && m.engineMeta?.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  latestId(chatId: string): string | null {
    const newest = [...this.byId.values()]
      .filter((m) => m.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0];
    return newest?.id ?? null;
  }

  searchText(query: string, limit: number, offset = 0): { messageId: string; chatId: string; snippet: string }[] {
    // Every word must appear, like the SQLite store's FTS match.
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    const results: { messageId: string; chatId: string; snippet: string }[] = [];
    for (const m of this.byId.values()) {
      const text = m.parts
        .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join(' ');
      const lower = text.toLowerCase();
      if (!words.every((w) => lower.includes(w))) continue;

      const idx = lower.indexOf(words[0]!);
      const start = Math.max(0, idx - 20);
      const end = Math.min(text.length, idx + words[0]!.length + 20);
      results.push({ messageId: m.id, chatId: m.chatId, snippet: text.slice(start, end) });
      if (results.length >= offset + limit) break;
    }
    return results.slice(offset);
  }
}

class InMemoryArtifactRepo implements ArtifactRepo {
  private readonly artifacts = new Map<string, Artifact>();
  private readonly versionsById = new Map<string, ArtifactVersion>();

  create(a: Artifact): Artifact {
    if (this.artifacts.has(a.id)) throw new Error(`Artifact "${a.id}" already exists.`);
    this.artifacts.set(a.id, { ...a });
    return { ...a };
  }
  get(id: string): Artifact | null {
    const a = this.artifacts.get(id);
    return a ? { ...a } : null;
  }
  bySlug(chatId: string, slug: string): Artifact | null {
    for (const a of this.artifacts.values()) if (a.chatId === chatId && a.slug === slug) return { ...a };
    return null;
  }
  listByChat(chatId: string): Artifact[] {
    return [...this.artifacts.values()].filter((a) => a.chatId === chatId).sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id)).map((a) => ({ ...a }));
  }
  addVersion(v: NewArtifactVersion): ArtifactVersion {
    const artifact = this.artifacts.get(v.artifactId);
    if (!artifact) throw new Error(`Artifact "${v.artifactId}" not found.`);
    const number = Math.max(0, ...this.versions(v.artifactId).map((x) => x.number)) + 1;
    const full: ArtifactVersion = { ...v, kind: v.kind ?? artifact.kind, language: v.language !== undefined ? v.language : artifact.language, number };
    this.versionsById.set(v.id, full);
    return { ...full };
  }
  versionInfos(artifactId: string): ArtifactVersionInfo[] {
    // Not through versions(), so a test can tell which of the two a caller used.
    return [...this.versionsById.values()].filter((v) => v.artifactId === artifactId).sort((x, y) => x.number - y.number).map(({ content: _content, ...info }) => info);
  }
  getVersion(id: string): ArtifactVersion | null {
    const v = this.versionsById.get(id);
    return v ? { ...v } : null;
  }
  versions(artifactId: string): ArtifactVersion[] {
    return [...this.versionsById.values()].filter((v) => v.artifactId === artifactId).sort((x, y) => x.number - y.number).map((v) => ({ ...v }));
  }
}

/** A `Store` test double backed entirely by in-memory `Map`s. No SQL, no I/O. */
export class InMemoryStore implements Store {
  readonly nodes: NodeRepo;
  readonly locations: LocationRepo;
  readonly peers: PeerRepo = new InMemoryPeerRepo();
  readonly connections: ConnectionRepo = new InMemoryConnectionRepo();
  readonly models: ModelRepo = new InMemoryModelRepo();
  readonly chats: ChatRepo;
  readonly projectMemory: ProjectMemoryRepo;
  readonly globalMemory: GlobalMemoryRepo = new InMemoryGlobalMemoryRepo();
  readonly projects: ProjectRepo;
  readonly profiles: ProfileRepo;
  readonly settings: SettingsRepo = new InMemorySettingsRepo();
  readonly messages: MessageRepo;
  readonly attachments: AttachmentRepo = new InMemoryAttachmentRepo();
  readonly usage: UsageRepo = new InMemoryUsageRepo();
  readonly mcpServers: McpServerRepo = new InMemoryMcpServerRepo();
  readonly grants: GrantRepo = new InMemoryGrantRepo();
  readonly artifacts: ArtifactRepo = new InMemoryArtifactRepo();
  readonly audit: AuditRepo;

  /** `selfNodeId` is this store's machine; two stores with different ids stand in for two machines. */
  constructor(selfNodeId = 'node-self') {
    this.nodes = new InMemoryNodeRepo(selfNodeId);
    const chats = new InMemoryChatRepo(selfNodeId);
    this.chats = chats;
    this.messages = new InMemoryMessageRepo(selfNodeId);
    this.audit = new InMemoryAuditRepo(selfNodeId);
    // The project and memory repos refer to each other lazily (existence check, cascade on delete).
    const memoryRepo = new InMemoryProjectMemoryRepo((id) => this.projects.get(id) !== null);
    this.projectMemory = memoryRepo;
    const projects = new InMemoryProjectRepo(this.chats, (id) => memoryRepo.removeProject(id), selfNodeId);
    this.projects = projects;
    this.locations = new InMemoryLocationRepo((id) => {
      chats.clearLocation(id);
      projects.clearLocation(id);
    });
    this.profiles = new InMemoryProfileRepo(this.projects);
  }

  /** Just runs `fn`: there is nothing to roll back to. */
  transaction<T>(fn: () => T): T {
    return fn();
  }

  close(): void {
    // Nothing to release -- no file handle, no connection pool.
  }
}
