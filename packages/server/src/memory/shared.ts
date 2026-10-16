import { randomUUID } from 'node:crypto';
import type { ChatEngine, EngineEvent } from '@otherbench/core/ports/chat-engine.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { Scheduler } from './scheduler.js';

// What project memory and global memory's summarisers share: the one update
// queue, the tool-less utility call to the memory model, and picking that model.

/** How long one summariser call may take before it is abandoned. */
export const MEMORY_UPDATE_TIMEOUT_MS = 120_000;

/** Finish reasons (AI SDK and Anthropic spellings) that mean the answer is incomplete or withheld. */
const TRUNCATING_FINISH_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens', 'model_context_window_exceeded', 'content-filter', 'refusal', 'error']);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs memory updates one at a time, project and global alike, so a slow or
 * metered memory model is never hit in parallel and each update reads the
 * note the previous one wrote.
 */
export class MemoryQueue {
  private tail: Promise<void> = Promise.resolve();
  private outstanding = 0;

  /** Runs `job` after everything queued before it. */
  add<T>(job: () => Promise<T>): Promise<T> {
    this.outstanding += 1;
    const run = this.tail.then(job);
    const done = (): void => {
      this.outstanding -= 1;
    };
    this.tail = run.then(done, done);
    return run;
  }

  /** Resolves once every queued job has finished. */
  async idle(): Promise<void> {
    while (this.outstanding > 0) {
      await this.tail;
      await Promise.resolve();
    }
  }
}

export interface AskDeps {
  engine: ChatEngine;
  scheduler: Scheduler;
  now: () => number;
  timeoutMs: number;
  /** Stops for the calls in flight, so the owner's dispose() can abort them. */
  running: Set<() => void>;
}

/**
 * One tool-less utility call, abandoned after `timeoutMs`. The whole
 * instruction is one user message: Claude Code's utility path reads only
 * that. Every wait on the stream races the timeout, so an engine that
 * ignores the abort can't hold the queue.
 */
export async function askMemoryModel(deps: AskDeps, profile: ResolvedProfile, chatId: string, prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  let timedOut = false;
  let stopped = false;
  let wake!: () => void;
  const interrupted = new Promise<'interrupted'>((resolve) => (wake = () => resolve('interrupted')));
  const stop = (): void => {
    stopped = true;
    controller.abort();
    wake();
  };
  deps.running.add(stop);
  const timer = deps.scheduler.setTimeout(() => {
    timedOut = true;
    stop();
  }, deps.timeoutMs);
  const timeoutFailure = { ok: false as const, error: `The model didn't answer within ${Math.round(deps.timeoutMs / 1000)} s.` };
  let text = '';
  let finished = false;
  let iterator: AsyncIterator<EngineEvent> | undefined;
  try {
    iterator = deps.engine
      .stream({
        profile,
        messages: [
          {
            id: `memory-prompt:${randomUUID()}`,
            chatId,
            parentId: null,
            role: 'user',
            parts: [{ type: 'text', text: prompt }],
            status: 'complete',
            error: null,
            producedBy: null,
            createdAt: deps.now(),
          },
        ],
        tools: [],
        signal: controller.signal,
        chatId,
        messageId: `memory-update:${randomUUID()}`,
        workspaceRoot: null,
        purpose: 'utility',
      })
      [Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([iterator.next(), interrupted]);
      if (step === 'interrupted' || step.done) break;
      const event = step.value;
      if (event.type === 'text-delta') text += event.text;
      else if (event.type === 'error') return timedOut ? timeoutFailure : { ok: false, error: event.error.message };
      else if (event.type === 'finish') {
        // A cut-off note must never be saved: it can parse as a valid, shorter note.
        if (TRUNCATING_FINISH_REASONS.has(event.finishReason)) {
          return { ok: false, error: `The model's answer was cut off (finish reason "${event.finishReason}").` };
        }
        // The note is complete; a Claude Code stream can stay open after this.
        finished = true;
        break;
      }
    }
  } catch (err) {
    return timedOut ? timeoutFailure : { ok: false, error: errorMessage(err) };
  } finally {
    deps.scheduler.clearTimeout(timer);
    deps.running.delete(stop);
    // Tear the call down (a Claude Code child, say) whether or not it finished.
    controller.abort();
    try {
      void Promise.resolve(iterator?.return?.()).catch(() => undefined);
    } catch {
      /* the engine's own problem */
    }
  }
  if (finished) return { ok: true, text };
  if (timedOut) return timeoutFailure;
  if (stopped) return { ok: false, error: 'The memory service was shut down.' };
  return { ok: true, text };
}

/**
 * The first of `candidates` that exists, isn't archived and resolves. The
 * mock engine answers everything with the same canned reply, so it can never
 * write a note: it's only used when it's `chosen` (the Memory model setting).
 */
export async function pickMemoryProfile(
  store: Store,
  resolveProfile: (profileId: string) => Promise<ResolvedProfile>,
  candidates: (string | null)[],
  chosen: string | null
): Promise<ResolvedProfile | null> {
  for (const id of new Set(candidates)) {
    if (id === null) continue;
    const row = store.profiles.get(id);
    if (!row || row.archivedAt !== null) continue;
    try {
      const profile = await resolveProfile(id);
      if (profile.connection.kind === 'mock' && id !== chosen) continue;
      return profile;
    } catch {
      continue;
    }
  }
  return null;
}
