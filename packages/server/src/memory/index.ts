import type { MemoryFailure, MemoryUpdateOutcome } from '@grunt/core/domain/memory.js';
import type { TurnEvent } from '@grunt/core/domain/turn.js';
import type { GlobalMemoryService } from './global.js';
import type { ProjectMemoryService } from './service.js';

/**
 * Project and global memory as one set of hooks for the routes and the
 * container: a turn starting or finishing, a chat excluded or moved, startup
 * and shutdown all reach both summarisers. Global memory is optional, so a
 * container built for project memory alone still works.
 */
export class MemoryServices {
  constructor(
    readonly project: ProjectMemoryService,
    readonly global: GlobalMemoryService | null = null
  ) {}

  attach(turnRunner: { on(cb: (e: TurnEvent) => void): () => void }): () => void {
    const offProject = this.project.attach(turnRunner);
    const offGlobal = this.global?.attach(turnRunner);
    return () => {
      offProject();
      offGlobal?.();
    };
  }

  noteTurnCompleted(chatId: string): void {
    this.project.noteTurnCompleted(chatId);
    this.global?.noteTurnCompleted(chatId);
  }

  noteTurnStarted(chatId: string): void {
    this.project.noteTurnStarted(chatId);
    this.global?.noteTurnStarted(chatId);
  }

  cancel(chatId: string): void {
    this.project.cancel(chatId);
    this.global?.cancel(chatId);
  }

  /** "Update now" in a project chat: project memory only. */
  updateNow(chatId: string): Promise<MemoryUpdateOutcome> {
    return this.project.updateNow(chatId);
  }

  sweep(): void {
    this.project.sweep();
    this.global?.sweep();
  }

  lastError(projectId: string): MemoryFailure | null {
    return this.project.lastError(projectId);
  }

  lastGlobalError(): MemoryFailure | null {
    return this.global?.lastError() ?? null;
  }

  async idle(): Promise<void> {
    await this.project.idle();
    await this.global?.idle();
  }

  dispose(): void {
    this.project.dispose();
    this.global?.dispose();
  }
}
