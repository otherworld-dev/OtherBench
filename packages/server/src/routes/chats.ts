import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { TurnEvent } from '@grunt/core/domain/turn.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import type { RecordedUsage } from '@grunt/core/types/usage.js';
import { sweepOrphanedBlobs } from '@grunt/store-sqlite/blob-gc.js';
import type { Container } from '../container.js';
import { appDefaultProfileId, resolveProfile } from '../profile-resolution.js';
import { optionalBoolean, optionalWorkspaceRoot, requireNonEmptyString } from '../validation.js';

interface ChatBody {
  title?: unknown;
  profileId?: unknown;
  workspaceRoot?: unknown;
  pinned?: unknown;
  archivedAt?: unknown;
  autoMode?: unknown;
  projectId?: unknown;
  memoryExcluded?: unknown;
  sortOrder?: unknown;
}

/** PATCH keys that file or configure a chat rather than use it: a PATCH of only these leaves `updatedAt` (the list order) alone. */
const NON_ACTIVITY_KEYS: ReadonlySet<string> = new Set(['autoMode', 'projectId', 'memoryExcluded', 'sortOrder']);

const DEFAULT_TITLE = 'New Chat';
const DEFAULT_SEARCH_LIMIT = 50;

function getChatOrThrow(container: Container, id: string): Chat {
  const chat = container.store.chats.get(id);
  if (!chat) throw new HTTPException(404, { message: `Chat "${id}" not found.` });
  return chat;
}

function requireExistingProfile(container: Container, profileId: string): void {
  if (!container.store.profiles.get(profileId)) {
    throw new HTTPException(404, { message: `Profile "${profileId}" not found.` });
  }
}

/** An unknown project in a chat body is a bad request, not a missing resource (spec §2). */
function requireExistingProject(container: Container, value: unknown): Project {
  const projectId = requireNonEmptyString(value, 'projectId');
  const project = container.store.projects.get(projectId);
  if (!project) throw new HTTPException(400, { message: `"projectId": project "${projectId}" not found.` });
  return project;
}

/** The profile a chat created in `project` starts with when the request names none (spec §2, §5). */
function inheritedProfileId(container: Container, project: Project): string {
  const usable = (id: string | null): string | null => {
    if (id === null) return null;
    const profile = container.store.profiles.get(id);
    return profile && profile.archivedAt === null ? profile.id : null;
  };
  // The project's default, unless it was archived or deleted; then the app
  // default the web client also uses (the default profile, else the first).
  const appDefault = appDefaultProfileId(container.store);
  const chosen = usable(project.defaultProfileId) ?? appDefault;
  if (!chosen) throw new HTTPException(400, { message: 'There is no profile to start this chat with -- create one in Settings first.' });
  return chosen;
}

/**
 * Walks the chat's whole message tree (every variant of every turn, not
 * just the active branch) via `roots()` + `children()` -- `MessageRepo` has
 * no single "all messages in this chat" query, since the tree shape is the
 * point (see packages/core/src/domain/tree.ts): a flat table scan would
 * have to exist alongside the recursive parent/child queries for no benefit
 * here, so the walk is done at this call site instead of growing the port.
 *
 * Exported for routes/usage.ts, which needs the same "every assistant
 * message in this chat, not just the active branch" walk to find variants
 * whose usage row is missing entirely (task 28's errored-with-no-usage-row
 * honesty requirement -- see buildUsageRollup's doc).
 */
export function collectMessageTree(store: Store, chatId: string): CanonMessage[] {
  const result: CanonMessage[] = [];
  const queue = [...store.messages.roots(chatId)];
  while (queue.length > 0) {
    const message = queue.shift();
    if (!message) continue;
    result.push(message);
    queue.push(...store.messages.children(message.id));
  }
  return result;
}

export function chatsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(container.store.chats.list()));

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ChatBody;
    const project = body.projectId === undefined || body.projectId === null ? null : requireExistingProject(container, body.projectId);

    let profileId: string;
    if (body.profileId === undefined && project) {
      profileId = inheritedProfileId(container, project);
    } else {
      profileId = requireNonEmptyString(body.profileId, 'profileId');
      requireExistingProfile(container, profileId);
    }

    const title = typeof body.title === 'string' && body.title.length > 0 ? body.title : DEFAULT_TITLE;
    // The project's folder only when the request has no workspaceRoot at all:
    // an explicit null means "no folder". The folder is not checked on disk --
    // a missing one gives the usual workspace warnings when tools run (spec §5).
    const workspaceRoot =
      body.workspaceRoot !== undefined ? (optionalWorkspaceRoot(body.workspaceRoot, 'workspaceRoot') ?? null) : (project?.workspaceRoot ?? null);

    const created = container.store.chats.create({
      id: randomUUID(),
      title,
      profileId,
      headMessageId: null,
      workspaceRoot,
      pinned: false,
      archivedAt: null,
      projectId: project?.id ?? null,
    });
    return c.json(created, 201);
  });

  app.get('/:id', (c) => c.json(getChatOrThrow(container, c.req.param('id'))));

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    getChatOrThrow(container, id);
    const body = (await c.req.json().catch(() => ({}))) as ChatBody;

    // headMessageId is deliberately not accepted here -- moving it is an
    // explicit, separate action (POST /:id/head, routes/turns.ts) so that
    // selecting a compare-turn variant can never happen as a side effect of
    // an unrelated rename/pin/archive PATCH (task 16 decision #2).
    const patch: Partial<Omit<Chat, 'id'>> = {};
    if (body.title !== undefined) patch.title = requireNonEmptyString(body.title, 'title');
    if (body.profileId !== undefined) {
      const profileId = requireNonEmptyString(body.profileId, 'profileId');
      requireExistingProfile(container, profileId);
      patch.profileId = profileId;
    }
    if (body.workspaceRoot !== undefined) patch.workspaceRoot = optionalWorkspaceRoot(body.workspaceRoot, 'workspaceRoot') ?? null;
    if (body.pinned !== undefined) patch.pinned = optionalBoolean(body.pinned, 'pinned', false);
    if (body.archivedAt !== undefined) {
      patch.archivedAt = body.archivedAt === null ? null : Number(body.archivedAt);
    }
    if (body.autoMode !== undefined) patch.autoMode = optionalBoolean(body.autoMode, 'autoMode', false);
    if (body.memoryExcluded !== undefined) patch.memoryExcluded = optionalBoolean(body.memoryExcluded, 'memoryExcluded', false);
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number' || !Number.isFinite(body.sortOrder)) {
        throw new HTTPException(400, { message: '"sortOrder" must be a finite number.' });
      }
      patch.sortOrder = body.sortOrder;
    }
    if (body.projectId !== undefined) {
      // Moving files the chat; its folder and profile stay as they are (spec §2).
      patch.projectId = body.projectId === null ? null : requireExistingProject(container, body.projectId).id;
    }

    // Toggling Auto, turning project memory off or on, moving a chat to another project or reordering it is not
    // chat activity: such a PATCH leaves updatedAt alone. Every other PATCH, including an empty one, still bumps it.
    const keys = Object.keys(patch);
    const nonActivity = keys.length > 0 && keys.every((k) => NON_ACTIVITY_KEYS.has(k));
    if (!nonActivity) patch.updatedAt = Date.now();

    const updated = container.store.chats.update(id, patch);
    // A chat that stops contributing, or changes project, drops its pending memory timer.
    if (patch.memoryExcluded === true || patch.projectId !== undefined) container.memory?.cancel(id);
    return c.json(updated);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    getChatOrThrow(container, id);
    container.store.chats.delete(id);
    container.memory?.cancel(id);
    // Deleting a chat cascades its attachment rows away in SQLite (ON
    // DELETE CASCADE) -- sweep for any blob that left orphaned as a result.
    // `sweepOrphanedBlobs` swallows filesystem-level failures (a locked
    // file, a permissions error, ...) so those can never turn a successful
    // delete into a failed request; it does NOT swallow a programming/
    // wiring error (see its own doc), which surfaces as a 500 here on
    // purpose rather than silently no-op-ing.
    await sweepOrphanedBlobs(container.store, container.blobStore);
    return c.body(null, 204);
  });

  app.get('/:id/messages', (c) => {
    const chat = getChatOrThrow(container, c.req.param('id'));
    const messages = collectMessageTree(container.store, chat.id);
    // Each finished reply's recorded usage, keyed by message id, so the
    // compare tabs show what a reply cost at the price it ran at, after a
    // reload too (#819). One row per message; a later one would win.
    const usage: Record<string, RecordedUsage> = {};
    for (const u of container.store.usage.list(chat.id)) {
      usage[u.messageId] = {
        tokensIn: u.tokensIn,
        tokensOut: u.tokensOut,
        tokensCached: u.tokensCached,
        tokensReasoning: u.tokensReasoning,
        pricingSnapshot: u.pricingSnapshot,
        latencyMs: u.latencyMs,
      };
    }
    return c.json({ messages, headMessageId: chat.headMessageId, usage });
  });

  return app;
}

/** `GET /api/search` -- mounted separately (at the app's own root) since it isn't chat-scoped by id. */
export function searchRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/search', (c) => {
    const q = c.req.query('q');
    if (!q || q.trim().length === 0) {
      throw new HTTPException(400, { message: '"q" query parameter is required and must be non-empty.' });
    }
    const limitParam = c.req.query('limit');
    let limit = DEFAULT_SEARCH_LIMIT;
    if (limitParam !== undefined) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new HTTPException(400, { message: '"limit" must be a positive integer.' });
      }
      limit = parsed;
    }
    return c.json(container.store.messages.searchText(q, limit));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Auto-title
// ---------------------------------------------------------------------------

const TITLE_MAX_LENGTH = 48;
const TITLE_GENERATION_TIMEOUT_MS = 10_000;
/** Claude Code starts a whole CLI process for a utility call, so it gets longer. */
const CLAUDE_CODE_TITLE_GENERATION_TIMEOUT_MS = 30_000;

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .trim();
}

function truncateTitle(raw: string): string {
  // Strips a leading/trailing quote the model may add despite being asked
  // not to ("Capital of France" -> Capital of France) before truncating.
  const cleaned = raw.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  return cleaned.length > TITLE_MAX_LENGTH ? cleaned.slice(0, TITLE_MAX_LENGTH) : cleaned;
}

function fallbackTitle(userText: string): string {
  const truncated = userText.trim().slice(0, TITLE_MAX_LENGTH);
  return truncated.length > 0 ? truncated : DEFAULT_TITLE;
}

function buildTitlePrompt(userText: string, assistantText: string): CanonMessage {
  return {
    id: `title-prompt:${randomUUID()}`,
    chatId: '',
    parentId: null,
    role: 'user',
    parts: [
      {
        type: 'text',
        text:
          `Reply with ONLY a short title (at most ${TITLE_MAX_LENGTH} characters, no quotes, no trailing ` +
          `punctuation) summarizing this exchange:\n\nUser: ${userText}\nAssistant: ${assistantText}`,
      },
    ],
    status: 'complete',
    error: null,
    producedBy: null,
    createdAt: Date.now(),
  };
}

/**
 * Generates a title via the same engine/profile that produced `assistantMessage`,
 * with a hard timeout, and applies either the generated title or (on ANY
 * failure -- an engine error, an empty result, or the timeout) the first
 * `TITLE_MAX_LENGTH` characters of the user's message. Always resolves;
 * never throws -- a title-generation failure must never fail the turn it's
 * attached to (task 18 brief), and by construction this runs from an event
 * handler that fires strictly *after* `TurnRunner` already wrote the
 * message's final status, so there is nothing left for a throw here to fail
 * anyway.
 */
async function applyAutoTitle(container: Container, chatId: string, assistantMessage: CanonMessage): Promise<void> {
  const userMessage = assistantMessage.parentId ? container.store.messages.get(assistantMessage.parentId) : null;
  const userText = userMessage ? textOf(userMessage.parts) : '';
  const fallback = fallbackTitle(userText);

  try {
    if (!assistantMessage.producedBy) throw new Error('Completed assistant message has no producedBy.');
    const profile = await resolveProfile(container, assistantMessage.producedBy.profileId);
    const assistantText = textOf(assistantMessage.parts);
    const prompt = buildTitlePrompt(userText, assistantText);

    const controller = new AbortController();
    // This controller is only ever aborted by the timer below, so this flag
    // is currently equivalent to `controller.signal.aborted` -- but naming
    // it explicitly "the watchdog fired" (rather than "aborted", a broader
    // concept) keeps the fallback decision below correct by construction
    // even if this function ever grows another abort source.
    let timedOut = false;
    const budgetMs = profile.connection.kind === 'claude_code' ? CLAUDE_CODE_TITLE_GENERATION_TIMEOUT_MS : TITLE_GENERATION_TIMEOUT_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budgetMs);
    let generated = '';
    // The title is complete at `finish`. Stop reading there: an engine's
    // stream can stay open after it (Claude Code's ends only when its process
    // exits), and that tail must not let the watchdog throw a finished title away.
    let finished = false;
    try {
      for await (const event of container.engine.stream({
        profile,
        messages: [prompt],
        tools: [],
        signal: controller.signal,
        chatId,
        messageId: `title-gen:${randomUUID()}`,
        workspaceRoot: null,
        purpose: 'utility',
      })) {
        if (event.type === 'text-delta') generated += event.text;
        else if (event.type === 'error') throw new Error(event.error.message);
        else if (event.type === 'finish') {
          finished = true;
          break;
        }
      }
    } finally {
      clearTimeout(timer);
    }

    // The engine can end a stream cleanly with no `error` event when the
    // signal it was given aborts (mirrors TurnRunner.runVariant's own
    // handling of the same behaviour, turn.ts) -- so a timeout leaves
    // `generated` holding whatever partial text streamed before the
    // watchdog fired, not an empty string. Per this function's documented
    // contract (ANY failure -- engine error, empty result, OR timeout --
    // uses the fallback), a timeout before `finish` must win over partial
    // text unconditionally, rather than falling through to `truncateTitle`
    // whenever `generated` happens to be non-empty.
    if (timedOut && !finished) {
      console.warn(`[grunt] auto-title for chat ${chatId} timed out after ${budgetMs / 1000}s; using the first message as the title.`);
      container.store.chats.update(chatId, { title: fallback });
      return;
    }

    const title = truncateTitle(generated);
    container.store.chats.update(chatId, { title: title.length > 0 ? title : fallback });
  } catch (err) {
    console.warn(`[grunt] auto-title for chat ${chatId} failed (${(err instanceof Error ? err.message : String(err)).slice(0, 300)}); using the first message as the title.`);
    container.store.chats.update(chatId, { title: fallback });
  }
}

/**
 * Subscribes to `container.turnRunner`'s events and triggers `applyAutoTitle`
 * the first time an assistant message in a chat reaches `complete`. Must be
 * called exactly once per `Container` (real usage: once from
 * `createContainer()`) -- unlike `chatsRoutes`/`searchRoutes`, which are
 * pure route wiring safe to call any number of times, calling this more
 * than once for the same container would register duplicate listeners and
 * race two independent title-generation attempts against each other.
 *
 * "First" is determined by re-reading the chat's message tree at the
 * moment each completion event arrives and counting completed assistant
 * messages, rather than an in-memory flag: a flag could not tell two
 * variants of the very same compare turn apart from two different turns,
 * whereas "how many assistant messages have reached 'complete' in this
 * chat, right now" is DB-truth and monotonic -- whichever variant's
 * completion is observed first (by TurnRunner, before either's own
 * title-generation call resolves) sees a count of exactly one and proceeds;
 * every other completion in the chat, including the compare turn's sibling
 * finishing later, always sees more than one and skips.
 */
export function subscribeAutoTitle(container: Container): () => void {
  return container.turnRunner.on((event: TurnEvent) => {
    if (event.type !== 'status' || event.status !== 'complete') return;

    const message = container.store.messages.get(event.messageId);
    if (!message || message.role !== 'assistant') return;

    const chat = container.store.chats.get(message.chatId);
    if (!chat) return;

    const completedCount = collectMessageTree(container.store, message.chatId).filter(
      (m) => m.role === 'assistant' && m.status === 'complete'
    ).length;
    if (completedCount !== 1) return; // Not the first ever completion in this chat.

    void applyAutoTitle(container, message.chatId, message);
  });
}
