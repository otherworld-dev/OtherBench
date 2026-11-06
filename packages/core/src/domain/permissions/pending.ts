/**
 * The permission broker's pending approvals (`../permissions.ts`): every
 * 'ask' `decide()` returns is remembered here until `resolve()` answers it,
 * `discard()` drops it, or the backstop below evicts it. An id that has left
 * is unknown for good, so it can never become an allow or mint a grant.
 */
import type { ToolContext, ToolSpec } from '../../ports/tool-provider.js';

/** Generous: a person answers a handful of cards at a time, so reaching this means requests are leaking. */
export const DEFAULT_MAX_PENDING = 200;

/** What `decide()` remembers about a pending 'ask' so `resolve()` can act on it later. */
export interface PendingRequest {
  tool: ToolSpec;
  ctx: ToolContext;
  /**
   * The exact arguments the pending call was made with. Retained because a
   * `'chat'`-scope answer for a SHELL tool is persisted as a grant for that
   * one exact command string (see `resolve()`); without the args there is
   * nothing to scope such a grant to and it would have to be blanket.
   */
  args: unknown;
}

export class PendingApprovals {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly evictListeners = new Set<(requestId: string) => void>();

  constructor(private readonly maxPending: number) {}

  get size(): number {
    return this.pending.size;
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  get(requestId: string): PendingRequest | undefined {
    return this.pending.get(requestId);
  }

  delete(requestId: string): void {
    this.pending.delete(requestId);
  }

  /** Stores a new request, after the backstop has made room for it (`enforceBound`). */
  add(requestId: string, request: PendingRequest): void {
    this.enforceBound(request.ctx.messageId);
    this.pending.set(requestId, request);
  }

  /**
   * Subscribes to the BACKSTOP evicting a request (see `enforceBound`). The
   * eviction is a safety net for a request whose owner never ended it; whoever
   * is waiting on it (OtherBenchToolProvider) must settle that wait as a denial.
   * Never fired by `resolve()`/`discard()`, which are the callers' own doing.
   */
  onEvict(cb: (requestId: string) => void): () => void {
    this.evictListeners.add(cb);
    return () => this.evictListeners.delete(cb);
  }

  /**
   * Defence in depth for the pending map. Every request is meant to leave it
   * through `resolve()` or `discard()` (the provider does both when a turn or
   * variant ends), so this only fires when some path was missed. Before each
   * new request is stored it (1) drops requests whose turn signal has aborted
   * -- their turn is gone, nobody can answer them -- and (2) if the map is
   * still at `maxPending`, evicts the oldest ones (Map keeps insertion order)
   * to make room. Each eviction is logged with `console.warn` so a leak path
   * stays visible instead of quietly masked, and reported to `onEvict`
   * listeners so the waiting call is settled as a DENIAL. An evicted request
   * is simply unknown afterwards: `resolve()` throws for it, so it can never
   * become an allow or mint a grant.
   */
  private enforceBound(messageId: string): void {
    for (const [id, p] of this.pending) {
      if (p.ctx.signal.aborted) this.evict(id, 'its turn was aborted but it was never discarded -- a lifecycle path missed it');
    }
    while (this.pending.size >= this.maxPending) {
      // Evict from the message that is asking first, so one runaway step
      // cannot push out a live card belonging to another chat or variant.
      let victim: string | undefined;
      for (const [id, p] of this.pending) {
        if (p.ctx.messageId === messageId) {
          victim = id;
          break;
        }
      }
      const own = victim !== undefined;
      victim ??= this.pending.keys().next().value;
      if (victim === undefined) break;
      this.evict(
        victim,
        own
          ? `message "${messageId}" alone has raised too many approvals (cap ${this.maxPending}); dropping its oldest`
          : `${this.maxPending} approvals are pending across all chats; dropping the oldest`
      );
    }
  }

  private evict(requestId: string, why: string): void {
    this.pending.delete(requestId);
    console.warn(`[PermissionBroker] backstop dropped pending approval "${requestId}": ${why}.`);
    for (const cb of this.evictListeners) {
      try {
        cb(requestId);
      } catch (err) {
        console.error('[PermissionBroker] an evict listener threw:', err);
      }
    }
  }
}
