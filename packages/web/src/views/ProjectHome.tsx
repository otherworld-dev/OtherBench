import { useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { hasMemoryContent } from '@grunt/core/domain/memory.js';
import { compareProjects, projectLookup, projectParentOf } from '@grunt/core/domain/projects.js';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { MarkdownBody } from '../components/MarkdownBody.js';
import { StatusDot } from '../components/StatusDot.js';
import { memoryUpdatedLine } from '../lib/memoryUpdated.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { allGroups, buildSidebar } from '../panes/sidebar/model.js';
import { ApiError } from '../state/api.js';
import { chatStatus, useChatActivity } from '../state/chatStatus.js';
import { projectTabId } from '../state/projectTab.js';
import { StartChatError, startChat } from '../state/startChat.js';
import { useGruntStore } from '../state/store.js';
import { useProjectMemory } from '../state/useProjectMemory.js';
import { awayFolderWhere } from './project/folders.js';

const HEADING = 'label-caps mb-1.5 text-[var(--text-muted)]';
const EMPTY = 'text-sm text-[var(--text-faint)]';

/**
 * A project's home page, open as a tab (spec 2026-10-15-project-home-design §3):
 * what the project is, a box to start a chat in it, its chats, and read-only
 * instructions, folders, default profile and memory. Editing stays in
 * Project settings and, for memory, the Inspector.
 */
export function ProjectHome({ projectId }: { projectId: string }): JSX.Element {
  const project = useGruntStore((s) => s.projects.find((p) => p.id === projectId) ?? null);
  const projectsLoaded = useGruntStore((s) => s.projectsLoaded);
  const closeTab = useGruntStore((s) => s.closeTab);
  // A restored tab renders before the project list arrives: that isn't a deleted project.
  if (!project && !projectsLoaded) return <p className={`p-6 ${EMPTY}`}>Loading…</p>;
  if (!project) {
    return (
      <div data-testid="project-home" className="h-full min-h-0 overflow-y-auto bg-[var(--bg)] p-6">
        <p className="text-sm text-[var(--text-muted)]">This project no longer exists. It may have been deleted in another tab or on another machine.</p>
        <button type="button" onClick={() => closeTab(projectTabId(projectId))} className="btn mt-3 px-2.5 py-1">
          Close
        </button>
      </div>
    );
  }
  return <ProjectHomeBody project={project} />;
}

function ProjectHomeBody({ project }: { project: Project }): JSX.Element {
  const openProjectPage = useGruntStore((s) => s.openProjectPage);
  const openTab = useGruntStore((s) => s.openTab);
  const projects = useGruntStore((s) => s.projects);
  const parent = projectParentOf(project, projectLookup(projects));
  return (
    <div data-testid="project-home" className="@container h-full min-h-0 overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-medium">{project.name}</h2>
            {parent && (
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                In{' '}
                <button type="button" data-testid="home-parent" onClick={() => openTab(projectTabId(parent.id))} className="underline hover:text-[var(--text)]">
                  {parent.name}
                </button>
              </p>
            )}
            {project.description && <p className="mt-1 text-sm text-[var(--text-muted)] [overflow-wrap:anywhere]">{project.description}</p>}
          </div>
          <button type="button" onClick={() => openProjectPage({ mode: 'edit', projectId: project.id })} className="btn shrink-0 px-2.5 py-1">
            Settings…
          </button>
        </div>
        <StartBox project={project} />
        <SubProjects projectId={project.id} />
        {/* minmax(0, …) tracks and min-w-0 items: a long unbroken word wraps rather than widening the page. */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 @2xl:grid-cols-[minmax(0,1fr)_18rem]">
          <ProjectChats projectId={project.id} />
          <About project={project} />
        </div>
      </div>
    </div>
  );
}

/**
 * Per project, the chat a start whose message didn't send made: the retry
 * sends into it rather than making another. Outside the component so it
 * survives the page being left and reopened.
 */
const pendingStarts = new Map<string, string>();

export function resetPendingStartsForTests(): void {
  pendingStarts.clear();
}

/**
 * The pending chat as it is now, if it can still take a first message: not
 * deleted, archived or moved to another project, and still empty. Otherwise
 * it's forgotten and the next send makes a new chat.
 */
function pendingStart(projectId: string): Chat | undefined {
  const id = pendingStarts.get(projectId);
  if (id === undefined) return undefined;
  const chat = useGruntStore.getState().chats.find((c) => c.id === id);
  if (chat && chat.projectId === projectId && chat.archivedAt === null && chat.headMessageId === null) return chat;
  pendingStarts.delete(projectId);
  return undefined;
}

/**
 * Puts a chat started from a project page in the pane showing that page,
 * leaving focus wherever the user went while it was sending. A pane that has
 * moved on to something else is left alone: the chat waits in the sidebar.
 */
function showInPagePane(projectId: string, chatId: string): void {
  const { paneState, focusPane, setActiveChatId } = useGruntStore.getState();
  const at = paneState.panes.indexOf(projectTabId(projectId));
  if (at === -1) return;
  const back = paneState.focusedPane;
  focusPane(at);
  setActiveChatId(chatId);
  focusPane(back);
}

function StartBox({ project }: { project: Project }): JSX.Element {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(): Promise<void> {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const pending = pendingStart(project.id);
      const chat = await startChat({ projectId: project.id, ...(pending ? { chat: pending } : {}), text: body });
      pendingStarts.delete(project.id);
      setText('');
      showInPagePane(project.id, chat.id);
    } catch (err) {
      if (err instanceof StartChatError) pendingStarts.set(project.id, err.chat.id);
      const cause = err instanceof StartChatError ? err.cause : err;
      console.error(`[grunt-web] failed to start a chat in project ${project.id}:`, cause);
      setError(cause instanceof ApiError ? cause.message : "Couldn't start the chat. Please try again.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  }

  return (
    <div>
      <textarea
        aria-label={`Start a chat in ${project.name}`}
        placeholder={`Start a chat in ${project.name}…`}
        value={text}
        readOnly={sending}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="w-full resize-y rounded border border-[var(--border-strong)] bg-[var(--bg)] px-3 py-2 text-sm read-only:opacity-60 focus:border-[var(--accent)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
      />
      {error && (
        <p role="alert" className="mt-1 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

/** A parent project's sub-projects, each opening its own page (spec 2026-10-15-sub-projects-design §6); nothing for one without. */
function SubProjects({ projectId }: { projectId: string }): JSX.Element | null {
  const projects = useGruntStore((s) => s.projects);
  const chats = useGruntStore((s) => s.chats);
  const openTab = useGruntStore((s) => s.openTab);
  const lookup = projectLookup(projects);
  const subs = [...projects].sort(compareProjects).filter((p) => projectParentOf(p, lookup)?.id === projectId);
  if (subs.length === 0) return null;
  return (
    <section data-testid="home-sub-projects" aria-label="Sub-projects" className="min-w-0">
      <h3 className={HEADING}>Sub-projects</h3>
      <ul className="flex flex-wrap gap-2">
        {subs.map((p) => {
          const count = chats.filter((c) => c.projectId === p.id && c.archivedAt === null).length;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => openTab(projectTabId(p.id))}
                className="flex items-center gap-2 rounded-sm border border-[var(--border)] bg-[var(--bg-raised)] px-2.5 py-1.5 text-sm hover:bg-[var(--bg-sunken)]"
              >
                <span className="truncate">{p.name}</span>
                <span className="text-xs text-[var(--text-faint)] tabular-nums">
                  {count} {count === 1 ? 'chat' : 'chats'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ProjectChats({ projectId }: { projectId: string }): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const projects = useGruntStore((s) => s.projects);
  const setActiveChatId = useGruntStore((s) => s.setActiveChatId);
  const { waiting, working } = useChatActivity();
  // The sidebar's own grouping, so the page and the sidebar always agree on order.
  const listed = useMemo(() => {
    const group = allGroups(buildSidebar(chats, projects, null)).find((g) => g.key === projectId);
    return group ? [...group.pinnedChats, ...group.chats] : [];
  }, [chats, projects, projectId]);

  return (
    <section data-testid="home-chats" aria-label="Chats" className="min-w-0">
      <h3 className={HEADING}>Chats</h3>
      {listed.length === 0 ? (
        <p className={EMPTY}>No chats yet</p>
      ) : (
        <ul className="space-y-0.5">
          {listed.map((c) => {
            const status = chatStatus(c, waiting, working);
            return (
              <li key={c.id} data-chat-id={c.id} className="flex items-center rounded-sm hover:bg-[var(--bg-sunken)]">
                <button type="button" onClick={() => setActiveChatId(c.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm">
                  <span className={`min-w-0 flex-1 truncate ${status === 'ready' ? 'font-medium' : ''}`}>{c.title}</span>
                  <span className="shrink-0 text-xs text-[var(--text-faint)]">{formatRelativeTime(c.updatedAt)}</span>
                </button>
                {/* Beside the button, not in it, so a screen reader reads the status (as in ChatRow). */}
                {status && <StatusDot status={status} testId={`home-chat-status-${c.id}`} className="mx-2" />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function About({ project }: { project: Project }): JSX.Element {
  const profiles = useGruntStore((s) => s.profiles);
  const profile = project.defaultProfileId === null ? null : (profiles.find((p) => p.id === project.defaultProfileId) ?? null);
  const away = awayFolderWhere(project);
  const extra = project.folderViews ?? [];
  const hasFolder = Boolean(project.workspaceRoot) || away !== null || extra.length > 0;

  return (
    <div className="min-w-0 space-y-4">
      <section aria-label="Instructions">
        <h3 className={HEADING}>Instructions</h3>
        {project.instructions ? <Clamped text={project.instructions} /> : <p className={EMPTY}>No instructions</p>}
      </section>
      <section aria-label="Folders">
        <h3 className={HEADING}>Folders</h3>
        {!hasFolder && <p className={EMPTY}>No folder</p>}
        {project.workspaceRoot && <p className="break-all font-mono text-xs">{project.workspaceRoot}</p>}
        {away && <p className="text-xs text-[var(--text-muted)]">{away}</p>}
        {extra.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {extra.map((f, i) => (
              <li key={i} className="text-xs">
                <span className="break-all font-mono">{f.root ?? 'Not set up on this machine'}</span>
                <span className="text-[var(--text-faint)]">{f.access === 'read' ? ' · read only' : ' · read and write'}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Default profile">
        <h3 className={HEADING}>Default profile</h3>
        <p className="text-sm">{profile?.name ?? "Grunt's default profile"}</p>
      </section>
      <section aria-label="Memory">
        <h3 className={HEADING}>Memory</h3>
        <MemoryPanel projectId={project.id} />
      </section>
    </div>
  );
}

function MemoryPanel({ projectId }: { projectId: string }): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const { view, loadFailed } = useProjectMemory(projectId);
  if (!view) return <p className={EMPTY}>{loadFailed ? "Couldn't load project memory." : 'Loading…'}</p>;
  return (
    <div className="space-y-1">
      {/* An unsaved note is the template's empty headings, not blank. */}
      {hasMemoryContent(view.memory.body) ? <Clamped text={view.memory.body} markdown /> : <p className={EMPTY}>No memory yet</p>}
      <p className="text-xs text-[var(--text-faint)]">{memoryUpdatedLine(view.memory, chats)}</p>
    </div>
  );
}

/**
 * Text cut to a few lines, kept as written or rendered as Markdown (memory,
 * as the Inspector shows it). Show more appears only when the text really is
 * cut, measured as rendered, since a narrow pane wraps short text long. Focus
 * moving into the cut part (a link, by Tab) opens it, so nothing is focused
 * out of sight.
 */
function Clamped({ text, markdown = false }: { text: string; markdown?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || open) return;
    const measure = (): void => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);

  const clamp = open ? '' : markdown ? 'max-h-48 overflow-hidden' : 'line-clamp-8';
  return (
    <div>
      <div
        ref={box}
        data-clamp=""
        onFocus={() => {
          if (cut && !open) setOpen(true);
        }}
        className={`text-sm [overflow-wrap:anywhere] ${markdown ? '' : 'whitespace-pre-wrap'} ${clamp}`}
      >
        {markdown ? <MarkdownBody text={text} /> : text}
      </div>
      {(cut || open) && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-xs text-[var(--accent)] hover:underline">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
