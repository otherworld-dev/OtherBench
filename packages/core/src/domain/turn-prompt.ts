import { cutAtContextLine } from './context-lines.js';
import type { Chat, Project, Store } from '../ports/store.js';
import type { ToolSpec } from '../ports/tool-provider.js';
import type { CanonMessage } from '../types/messages.js';
import { runsShellInSandbox, type ResolvedProfile } from '../types/config.js';
import type { ResolvedFolder } from '../types/workspace.js';
import { MEMORY_QUIET_MS, hasMemoryContent, projectMemoryPrompt } from './memory.js';
import { projectDisplayName, projectInstructionsPrompt, projectParentOf } from './projects.js';
import { PROJECT_INDEX_MAX, aboutUserPrompt, currentFocusLine, globalMemoryPrompt, projectIndexPrompt } from './global-memory.js';
import { RECALL_GUIDANCE } from './recall.js';
import { availableToolsPrompt, namesItsTools } from './tools-prompt.js';
import { ARTIFACTS_GUIDANCE, artifactsListNote, artifactsOnBranch, branchOf } from './artifacts.js';
import { sandboxPrompt } from './sandbox-paths.js';
import { LIVE_ARTIFACTS_GUIDANCE } from './live-artifacts.js';
import { canReachFolders, extraFoldersPrompt } from './workspace.js';

/** How long a chat must be quiet before its global memory block is rebuilt (see `globalMemoryBlock`). */
const GLOBAL_BLOCK_STEADY_MS = MEMORY_QUIET_MS;

/** What a held memory block was built from that the user changes by hand: when any of it differs, the block is rebuilt at once. */
type UserSaves = Record<string, string>;
type HeldBlock = { block: string | null; at: number; saves: UserSaves };

/**
 * When the user last saved a note, as a held block knows it. A summariser's
 * save since leaves the time as it was, so only the user's own saves rebuild
 * a block that is being held.
 */
function lastUserSave(by: string | null | undefined, at: number | null | undefined, previous: string | undefined): string {
  return by === 'user' ? String(at) : (previous ?? '0');
}

function sameSaves(a: UserSaves, b: UserSaves): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * What a turn's request carries around the conversation: the blocks appended
 * to the profile's system prompt (global memory, project instructions and
 * memory, extra folders, the sandbox, tools, artifacts, recall), that prompt
 * as the history's system message, and the notes at the end of the user's
 * message. `TurnRunner` builds every variant's request through one of these;
 * the memory blocks and notes held steady across turns are kept here.
 */
export class TurnPromptBuilder {
  /** chatId -> the global memory block it last got, when, and the user saves it reflects. */
  private readonly globalBlocks = new Map<string, HeldBlock>();
  /** Each chat's project memory block, held steady like the global one (see `projectMemoryBlock`). */
  private readonly projectBlocks = new Map<string, HeldBlock>();
  /**
   * The notes each user message was sent with, by message and profile (see
   * `withNotes`), so a later request carries the message exactly as it went.
   */
  private readonly sentNotes = new Map<string, { notes: string[]; at: number }>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number,
    private readonly canonicalPath: (path: string) => string
  ) {}

  /**
   * The conversation this variant sees: every ancestor of the user message
   * down to (and including) it, with the profile's system prompt prepended
   * as a synthetic (unpersisted) system message when set. `Store.messages`
   * has no notion of a system message row -- the system prompt lives on
   * `Profile`, not in the tree -- so this is assembled fresh per variant
   * rather than read back from the store.
   */
  buildRequestMessages(userMessageId: string, profile: ResolvedProfile): CanonMessage[] {
    const history = cutAtContextLine(this.store.messages.pathToRoot(userMessageId));
    if (!profile.systemPrompt) return history;

    const systemMessage: CanonMessage = {
      id: `system:${profile.id}`,
      chatId: history[0]?.chatId ?? '',
      parentId: null,
      role: 'system',
      parts: [{ type: 'text', text: profile.systemPrompt }],
      status: 'complete',
      error: null,
      producedBy: null,
      createdAt: 0,
    };
    return [systemMessage, ...history];
  }

  /**
   * The profile with global memory appended to its system prompt (spec
   * 2026-10-08-global-memory-design §1): About you, then the learned note,
   * then the index of the user's projects, all straight after the profile's
   * own prompt so a project's own text comes later. Nothing for a profile
   * with global memory off. Read fresh each turn.
   */
  withGlobalMemory(profile: ResolvedProfile, chat: Chat | null, canRecall: boolean): ResolvedProfile {
    if (profile.useGlobalMemory === false) return profile;
    const block = this.globalMemoryBlock(chat, canRecall);
    if (!block) return profile;
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The chat's global memory block, held steady while the chat is active.
   * The summariser rewrites the note and project notes (their current focus
   * is in the index) a few minutes after any chat goes quiet; letting that
   * change an active chat's system prompt would throw away its prompt cache
   * and restart its Claude Code process. So the block a chat last got is
   * reused until the chat has been quiet for `GLOBAL_BLOCK_STEADY_MS` (its
   * cache is cold by then anyway). The user's own saves of About you or the
   * note apply at once.
   */
  private globalMemoryBlock(chat: Chat | null, canRecall: boolean): string | null {
    const memory = this.store.globalMemory.get();
    // Whether the turn offers recall changes the index's last line, so each
    // kind of turn keeps its own block: a compare between a profile with
    // recall and one without mustn't keep rebuilding both.
    const key = `${chat?.id ?? ''}:${canRecall}`;
    const now = this.now();
    const kept = this.globalBlocks.get(key);
    const saves: UserSaves = { about: String(memory.aboutUpdatedAt), note: lastUserSave(memory.noteUpdatedBy, memory.noteUpdatedAt, kept?.saves['note']) };
    if (kept && sameSaves(kept.saves, saves) && now - kept.at < GLOBAL_BLOCK_STEADY_MS) {
      kept.at = now;
      return kept.block;
    }
    const lookup = (id: string): Project | null => this.store.projects.get(id);
    // An app chat's own project is its app's linked one, the same chain its
    // instructions and memory come from (projectChain; spec
    // 2026-10-20-code-tab-design, Goal 9 and "Turn context").
    const ownProjectId = chat?.projectId ?? this.linkedProjectId(chat);
    const index = projectIndexPrompt(
      this.store.projects
        .list()
        .slice(0, PROJECT_INDEX_MAX)
        .map((p) => ({
          name: projectDisplayName(p, lookup),
          description: p.description,
          currentFocus: currentFocusLine(this.store.projectMemory.get(p.id)?.body ?? ''),
          current: p.id === ownProjectId,
        })),
      canRecall
    );
    const blocks = [aboutUserPrompt(memory.about), globalMemoryPrompt(memory.note), index].filter((b): b is string => b !== null);
    const block = blocks.length === 0 ? null : blocks.join('\n\n');
    this.globalBlocks.set(key, { block, at: now, saves });
    return block;
  }

  /**
   * The profile with the chat's project instructions appended to its system
   * prompt (spec 2026-10-08-project-page-design §2), straight after the
   * profile's own prompt and before project memory. Read fresh each turn, so
   * an edit reaches existing chats on their next message. Both engines read
   * the result, as for memory.
   */
  withProjectInstructions(profile: ResolvedProfile, chat: Chat | null): ResolvedProfile {
    // A sub-project's chats get the parent's instructions first, then the sub-project's own.
    const blocks = this.projectChain(chat)
      .map((p) => projectInstructionsPrompt(p.name, p.instructions))
      .filter((b): b is string => b !== null);
    if (blocks.length === 0) return profile;
    const block = blocks.join('\n\n');
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The chat's project and, for a sub-project, its parent first (spec
   * 2026-10-15-sub-projects-design §3): what instructions, memory and extra
   * folders are read from, top down. Empty outside a project.
   *
   * An app chat (spec 2026-10-20-code-tab-design, Goal 9 and "Turn context")
   * has no project of its own (`projectId` is null, so the memory summariser
   * never folds it into a note), but if its app links a project it reads that
   * project's instructions, memory note and folders through this same chain.
   * The link is read-only: nothing here writes to the project. It isn't
   * trusted: an app can name a project that no longer exists, which adds
   * nothing, same as a chat with no project.
   */
  projectChain(chat: Chat | null): Project[] {
    const projectId = chat?.projectId ?? this.linkedProjectId(chat);
    const project = projectId ? this.store.projects.get(projectId) : null;
    if (!project) return [];
    const parent = projectParentOf(project, (id) => this.store.projects.get(id));
    return parent ? [parent, project] : [project];
  }

  /** The project an app chat's app links, if any (see `projectChain`). */
  private linkedProjectId(chat: Chat | null): string | null {
    const app = chat?.appId ? this.store.apps.get(chat.appId) : null;
    return app?.linkedProjectId ?? null;
  }

  /**
   * The profile this variant's request carries: `profile` itself, or, for a
   * chat in a project whose memory note has any content, a copy whose system
   * prompt ends with the note (spec 2026-10-03-project-memory-design §3).
   * Both engines read it from here: the AI SDK engine through the synthetic
   * system message `buildRequestMessages` adds, Claude Code as its appended
   * system prompt (sent with every query, so a resumed session sees the
   * current note). Excluded chats still get it; exclusion only stops a chat
   * contributing.
   */
  withProjectMemory(profile: ResolvedProfile, chat: Chat | null): ResolvedProfile {
    const block = this.projectMemoryBlock(chat);
    if (!block) return profile;
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The chat's project memory block, held steady while the chat is active,
   * for the reason the global block is (`globalMemoryBlock`): the summariser
   * rewrites a project's note a few minutes after any of its chats goes
   * quiet, and that must not change the system prompt of another chat in the
   * project that is still going. The user's own saves, and a renamed or
   * moved project, apply at once.
   */
  private projectMemoryBlock(chat: Chat | null): string | null {
    const chain = this.projectChain(chat);
    if (!chat || chain.length === 0) return null;
    const notes = chain.map((p) => ({ project: p, memory: this.store.projectMemory.get(p.id) }));
    const now = this.now();
    const kept = this.projectBlocks.get(chat.id);
    const saves: UserSaves = Object.fromEntries(
      notes.flatMap(({ project, memory }) => [
        [`${project.id}:name`, project.name],
        [`${project.id}:note`, lastUserSave(memory?.updatedBy, memory?.updatedAt, kept?.saves[`${project.id}:note`])],
      ])
    );
    if (kept && sameSaves(kept.saves, saves) && now - kept.at < GLOBAL_BLOCK_STEADY_MS) {
      kept.at = now;
      return kept.block;
    }
    // A sub-project's chats read the parent's note first, then their own; only their own is written (memory service).
    const blocks = notes.flatMap(({ project, memory }) => (memory && hasMemoryContent(memory.body) ? [projectMemoryPrompt(project.name, memory.body)] : []));
    const block = blocks.length === 0 ? null : blocks.join('\n\n');
    this.projectBlocks.set(chat.id, { block, at: now, saves });
    return block;
  }

  /**
   * The profile with a note naming the turn's extra folders appended to its system prompt (spec
   * 2026-10-07-extra-folders); for reference only when none of its tools can reach them (canReachFolders).
   */
  withFolders(profile: ResolvedProfile, folders: ResolvedFolder[]): ResolvedProfile {
    if (folders.length === 0) return profile;
    const block = extraFoldersPrompt(folders, canReachFolders(profile.toolPolicy));
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The profile with the "# Sandbox" block (spec 2026-10-12-sandbox-design,
   * "Model guidance") when its shell runs in the sandbox: what run_command is
   * and where the workspace and each extra folder are in it, or, with file
   * access off, that it has none of them and runs in its own home. A chat
   * with no workspace can't run sandboxed commands at all, so it gets none.
   */
  withSandbox(profile: ResolvedProfile, workspaceRoot: string | null, folders: ResolvedFolder[]): ResolvedProfile {
    if (workspaceRoot === null || !runsShellInSandbox(profile.toolPolicy)) return profile;
    const block = sandboxPrompt(profile.toolPolicy.fs, workspaceRoot, folders, this.canonicalPath);
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The profile with a note naming the tools this turn offers appended to its
   * system prompt, so a change to them mid-chat reaches the model even when
   * its own earlier replies say otherwise. Claude Code runs its own tools and
   * gets no note; neither does a turn with no tools.
   */
  withTools(profile: ResolvedProfile, tools: readonly ToolSpec[]): ResolvedProfile {
    if (tools.length === 0 || !namesItsTools(profile.connection.kind)) return profile;
    const block = availableToolsPrompt(tools.map((t) => t.name));
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${block}` : block };
  }

  /**
   * The artifacts guidance (Deck #896) in the system prompt of a turn that
   * can make artifacts, for either engine, plus the live-artifact part (spec
   * 2026-10-12-live-artifacts) for a profile with MCP servers. Both are fixed
   * text, so the prompt stays the same per profile; the branch's artifacts go
   * with the user's message (withArtifactsList).
   */
  withArtifacts(profile: ResolvedProfile, tools: readonly ToolSpec[]): ResolvedProfile {
    if (!tools.some((t) => t.source === 'artifact')) return profile;
    const guidance = profile.toolPolicy.mcpServerIds.length > 0 ? `${ARTIFACTS_GUIDANCE}\n\n${LIVE_ARTIFACTS_GUIDANCE}` : ARTIFACTS_GUIDANCE;
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${guidance}` : guidance };
  }

  /** When to use the recall tool (spec 2026-10-09-recall-design), for a turn that offers it. Fixed text, so it never churns the prompt. */
  withRecall(profile: ResolvedProfile, canRecall: boolean): ResolvedProfile {
    if (!canRecall) return profile;
    return { ...profile, systemPrompt: profile.systemPrompt ? `${profile.systemPrompt}\n\n${RECALL_GUIDANCE}` : RECALL_GUIDANCE };
  }

  /**
   * This branch's artifacts by id, title, kind and version, as a note for the
   * end of the user's message (`withNotes`). Kept out of the system prompt so
   * that prompt stays the same as artifacts change. Contents stay out: the
   * tool's `view` reads one.
   */
  artifactsListNotes(tools: readonly ToolSpec[], chatId: string, userMessageId: string): string[] {
    if (!tools.some((t) => t.source === 'artifact')) return [];
    return [artifactsListNote(artifactsOnBranch(this.store, chatId, branchOf(this.store, userMessageId)))];
  }

  /**
   * `notes` (the artifacts list, the Plan mode note) at the end of the user's
   * message, in the request only: the stored message is untouched. Each
   * earlier user message on the branch gets back the notes it was sent with,
   * so the history a request carries is the same from turn to turn and the
   * provider's prompt cache keeps matching it; dropping them would change
   * every turn's previous message. Held for as long as the global memory
   * block is (a chat quiet that long has a cold cache anyway). Not for Claude
   * Code, which keeps its own session and reads only the new message.
   */
  withNotes(messages: CanonMessage[], notes: string[], userMessageId: string, profile: ResolvedProfile): CanonMessage[] {
    const now = this.now();
    for (const [key, kept] of this.sentNotes) if (now - kept.at >= GLOBAL_BLOCK_STEADY_MS) this.sentNotes.delete(key);
    const keyOf = (messageId: string): string => `${messageId}\u0000${profile.id}`;
    this.sentNotes.set(keyOf(userMessageId), { notes, at: now });
    const replay = profile.connection.kind !== 'claude_code';
    const append = (m: CanonMessage, texts: string[]): CanonMessage => (texts.length === 0 ? m : { ...m, parts: [...m.parts, ...texts.map((text) => ({ type: 'text' as const, text }))] });
    return messages.map((m) => {
      if (m.id === userMessageId) return append(m, notes);
      const kept = replay && m.role === 'user' ? this.sentNotes.get(keyOf(m.id)) : undefined;
      if (!kept) return m;
      kept.at = now;
      return append(m, kept.notes);
    });
  }
}
