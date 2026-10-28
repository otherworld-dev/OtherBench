import { HTTPException } from 'hono/http-exception';
import { continuePrompt, pickOtherAccount } from '@otherbench/core/domain/claude-accounts.js';
import { isCompareSet } from '@otherbench/core/domain/tree.js';
import type { Chat, Store } from '@otherbench/core/ports/store.js';
import { isClaudeLogin, MAIN_ACCOUNT, MAIN_ACCOUNT_SLUG } from '@otherbench/core/types/claude-accounts.js';
import type { CanonMessage, SerializedError } from '@otherbench/core/types/messages.js';
import type { Container } from '../container.js';
import { resolveProfile } from '../profile-resolution.js';
import { lineAfter, startTurn } from '../turn-start.js';

/** How long an account is held when its limit error doesn't say when it resets: the length of the 5-hour window. */
const UNKNOWN_RESET_HOLD_MS = 5 * 3600_000;

/** The refusal for a chat another machine runs, as the peer API words it (`kind: 'not_here'`). */
export const NOT_HERE = 'This chat runs on another machine.';

/**
 * The replies already carried on to another account, per container, whether
 * the switcher did it or the user asked: one Set for both, so a cut-off reply
 * is never continued twice. In memory only; a restart forgets it.
 */
const continuedReplies = new WeakMap<object, Set<string>>();

function continued(container: Container): Set<string> {
  let set = continuedReplies.get(container);
  if (!set) {
    set = new Set();
    continuedReplies.set(container, set);
  }
  return set;
}

/** A reply that ended in error because its Claude account hit the usage limit. */
function cutOffByLimit(message: CanonMessage): boolean {
  return message.role === 'assistant' && message.status === 'error' && message.error?.kind === 'rate_limit';
}

/** Whether the reply ran on a Claude login: its session's backend, or, when it failed before one started, its connection. */
function ranOnClaudeLogin(store: Store, message: CanonMessage): boolean {
  if (message.engineMeta) return isClaudeLogin(message.engineMeta.backend);
  const connection = message.producedBy ? store.connections.get(message.producedBy.connectionId) : null;
  return connection?.kind === 'claude_code' && !connection.baseUrl;
}

/**
 * Whether the reply is the live tip of the chat's thread: the one line a
 * continuation would carry on. Not a compare turn's variant, and the newest
 * reply among its siblings (a regenerated one is), with nothing after it. Its
 * parent is the head, or it was self-started on the head's line: a self-started
 * reply follows the reply before it while the head stays on the user message,
 * so every message between the head and it is a reply, each the newest child
 * of the one before, with no context line (/clear, /compact) on the way.
 */
function isLiveTip(store: Store, chat: Chat, message: CanonMessage): boolean {
  const head = chat.headMessageId;
  if (!message.parentId || !head) return false;
  const siblings = store.messages.children(message.parentId);
  if (isCompareSet(siblings)) return false;
  if (siblings.filter((m) => m.role === 'assistant').at(-1)?.id !== message.id) return false;
  if (store.messages.children(message.id).length > 0) return false;
  if (head === message.parentId) return true;
  const path = store.messages.pathToRoot(message.id);
  const at = path.findIndex((m) => m.id === head);
  if (at === -1 || lineAfter({ store }, message.id, head)) return false;
  const between = path.slice(at + 1, -1);
  if (between.length === 0 || between.some((m) => m.role !== 'assistant')) return false;
  // Each step down from the head is the newest message there: nothing newer sits on the head's thread.
  for (let i = at; i < path.length - 1; i++) {
    if (store.messages.children(path[i]!.id).at(-1)?.id !== path[i + 1]!.id) return false;
  }
  return true;
}

/** The slug of the account that wrote the reply; one that failed before its session started is taken to have run on the chat's. */
function producingAccount(chat: Chat, message: CanonMessage): string {
  if (message.engineMeta) return message.engineMeta.account ?? MAIN_ACCOUNT_SLUG;
  return chat.claudeAccount ?? MAIN_ACCOUNT_SLUG;
}

function detailOf(error: SerializedError | null): Record<string, unknown> {
  const detail = error?.detail;
  return typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
}

/** The reset time (ms) the engine put on a rate-limit error, or null when it didn't know it. */
function resetsAtOf(error: SerializedError | null): number | null {
  const resetsAt = detailOf(error)['resetsAt'];
  return typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : null;
}

/**
 * Whether the engine had real evidence the account is out of usage (a rejected
 * rate-limit event, a reset time, Claude Code's limit text). An overload or a
 * bare 429 is a `rate_limit` too, but must never hold an account or move a chat.
 */
function isUsageLimit(error: SerializedError | null): boolean {
  return detailOf(error)['usageLimit'] === true;
}

/**
 * Carries reply `messageId`, cut off by its Claude account's usage limit, on
 * to `account` (spec 2026-10-28-claude-accounts-design, "Switching mid-chat"):
 * the chat is moved to that account, and a new user message under the cut-off
 * reply asks Claude to carry on, on the profile that wrote it. The cut-off
 * reply is kept as it is. Any `rate_limit` reply may be continued this way,
 * an overload too: the user asked. If the turn can't start, the chat keeps
 * its account. Throws HTTPException: 404 for an unknown chat or message, 400
 * for an account this machine doesn't have, 409 when the message belongs to
 * another chat or isn't a reply cut off by a rate limit, when `account` is the
 * one that wrote it, when the chat runs on another machine, or when the reply
 * has been continued already.
 */
export async function continueOnAccount(
  container: Container,
  input: { chatId: string; messageId: string; account: string; midReply: boolean }
): Promise<{ userMessageId: string; assistantMessageIds: string[] }> {
  const { store } = container;
  const chat = store.chats.get(input.chatId);
  if (!chat) throw new HTTPException(404, { message: `Chat "${input.chatId}" not found.` });
  const message = store.messages.get(input.messageId);
  if (!message) throw new HTTPException(404, { message: `Message "${input.messageId}" not found.` });
  if (message.chatId !== chat.id) throw new HTTPException(409, { message: `Message "${input.messageId}" belongs to another chat.` });
  const accounts = container.claudeAccounts;
  const to = accounts ? accounts.ref(input.account) : input.account === MAIN_ACCOUNT_SLUG ? MAIN_ACCOUNT : null;
  if (!to) throw new HTTPException(400, { message: `No Claude account named "${input.account}" on this machine.` });
  if (chat.runsOn !== store.nodes.self().id) throw new HTTPException(409, { message: NOT_HERE });
  if (!cutOffByLimit(message) || !message.producedBy || !ranOnClaudeLogin(store, message)) {
    throw new HTTPException(409, { message: "That message isn't a Claude reply cut off by a usage limit." });
  }
  const fromSlug = producingAccount(chat, message);
  if (fromSlug === to.slug) throw new HTTPException(409, { message: `That reply was written on "${to.name}": choose another account.` });
  const done = continued(container);
  if (done.has(message.id)) throw new HTTPException(409, { message: 'That reply has been continued already.' });
  // Taken before the first await, so a second call for the same reply can't slip in while this one runs.
  done.add(message.id);

  try {
    const profile = await resolveProfile(container, message.producedBy.profileId);
    const fromName = accounts?.ref(fromSlug)?.name ?? fromSlug;
    const before = store.chats.get(chat.id)?.claudeAccount ?? null;
    store.chats.update(chat.id, { claudeAccount: to.slug });
    let result: Awaited<ReturnType<typeof startTurn>>;
    try {
      result = await startTurn(container, {
        chatId: chat.id,
        parentId: message.id,
        userParts: [{ type: 'text', text: continuePrompt(fromName, to.name) }],
        profiles: [profile],
      });
    } catch (err) {
      // Nothing started on the new account: the chat stays where it was.
      if (store.chats.get(chat.id)) store.chats.update(chat.id, { claudeAccount: before });
      throw err;
    }
    container.events?.emit({
      type: 'claude-account-switched',
      chatId: chat.id,
      from: fromName,
      to: to.name,
      resetsAt: accounts?.limitedUntil(fromSlug) ?? null,
      midReply: input.midReply,
    });
    return { userMessageId: result.userMessageId, assistantMessageIds: result.assistantMessageIds };
  } catch (err) {
    // Nothing was carried on, so it may be tried again.
    done.delete(message.id);
    throw err;
  }
}

/**
 * When a Claude reply ends cut off by its account's usage limit (the engine's
 * `detail.usageLimit`; an overload or a bare 429 is left alone): holds that
 * account as limited until the reset the error names (5 hours when it names
 * none), and either says every account is out of usage (only on a machine
 * with more than main) or, when the chat has "Switch automatically" on and the
 * reply is the live tip of its thread (`isLiveTip`), carries it on to the first
 * other account with room that isn't known to be signed out. Returns the unsubscribe.
 */
export function attachAccountSwitcher(container: Container): () => void {
  const { events } = container;
  if (!events) return () => {};
  return events.subscribe((e) => {
    if (e.type !== 'turn-finished' || e.status !== 'error') return;
    try {
      const run = onCutOff(container, e.messageId);
      if (run) run.catch((err: unknown) => console.error(`[otherbench-server] couldn't continue reply ${e.messageId} on another Claude account:`, err));
    } catch (err) {
      console.error(`[otherbench-server] couldn't handle the usage limit on reply ${e.messageId}:`, err);
    }
  });
}

/** Everything up to the continuation runs synchronously, so a repeated `turn-finished` sees the reply taken. */
function onCutOff(container: Container, messageId: string): Promise<unknown> | null {
  const { store, claudeAccounts: accounts } = container;
  if (!accounts) return null;
  const message = store.messages.get(messageId);
  if (!message || !cutOffByLimit(message) || !isUsageLimit(message.error) || !ranOnClaudeLogin(store, message)) return null;
  const chat = store.chats.get(message.chatId);
  // A reply run on a paired machine is that machine's to handle: its accounts are its own.
  if (!chat || chat.runsOn !== store.nodes.self().id) return null;

  const from = producingAccount(chat, message);
  const now = accounts.now();
  // A fallback (or an earlier reset) never shortens a longer hold the account already has.
  const until = resetsAtOf(message.error) ?? now + UNKNOWN_RESET_HOLD_MS;
  accounts.markLimited(from, Math.max(until, accounts.limitedUntil(from) ?? 0));

  // An account known to be signed out is never switched onto (nor listed as one to wait for).
  const candidates = accounts.candidates().filter((r) => r.slug !== from);
  const limitedUntil = (slug: string): number | null => accounts.limitedUntil(slug);
  const to = pickOtherAccount({ current: from, accounts: candidates, limitedUntil, now });
  if (!to) {
    // A machine with main alone has no other account to be out of: its limit is shown as it always was.
    if (accounts.refs().length > 1) {
      const listed = accounts.refs().filter((r) => r.slug === from || candidates.some((c) => c.slug === r.slug));
      container.events?.emit({ type: 'claude-accounts-exhausted', chatId: chat.id, resets: listed.map((r) => ({ name: r.name, resetsAt: limitedUntil(r.slug) })) });
    }
    return null;
  }

  if (!chat.accountAutoSwitch || !isLiveTip(store, chat, message)) return null;
  if (continued(container).has(message.id)) return null;
  return continueOnAccount(container, { chatId: chat.id, messageId: message.id, account: to.slug, midReply: true });
}
