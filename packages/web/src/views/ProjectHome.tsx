import { useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { StatusDot } from '../components/StatusDot.js';
import { memoryUpdatedLine } from '../lib/memoryUpdated.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { buildSidebar } from '../panes/sidebar/model.js';
import { ApiError } from '../state/api.js';
import { chatStatus, useChatActivity } from '../state/chatStatus.js';
import { projectTabId } from '../state/projectTab.js';
import { StartChatError, startChat } from '../state/startChat.js';
import { useGruntStore } from '../state/store.js';
import { useProjectMemory } from '../state/useProjectMemory.js';
import { awayFolderWhere } from './project/folders.js';

const HEADING = 'label-caps mb-1.5 text-[var(--text-muted)]';
const EMPTY = 'text-sm text-[var(--text-faint)]';
/** Text longer than this is cut, with Show more. */
const CLAMP_LINES = 8;
const CLAMP_CHARS = 600;

/**
 * A project's home page, open as a tab (spec 2026-10-15-project-home-design §3):
 * what the project is, a box to start a chat in it, its chats, and read-only
 * instructions, folders, default profile and memory. Editing stays in
 * Project settings and, for memory, the Inspector.
 */
export function ProjectHome({ projectId }: { projectId: string }): JSX.Element {
  const project = useGruntStore((s) => s.projects.find((p) => p.id === projectId) ?? null);
  const closeTab = useGruntStore((s) => s.closeTab);
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
  return (
    <div data-testid="project-home" className="@container h-full min-h-0 overflow-y-auto bg-[var(--bg)]">
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-medium">{project.name}</h2>
            {project.description && <p className="mt-1 text-sm text-[var(--text-muted)]">{project.description}</p>}
          </div>
          <button type="button" onClick={() => openProjectPage({ mode: 'edit', projectId: project.id })} className="btn shrink-0 px-2.5 py-1">
            Settings…
          </button>
        </div>
        <StartBox project={project} />
        <div className="grid gap-6 @2xl:grid-cols-[minmax(0,1fr)_18rem]">
          <ProjectChats projectId={project.id} />
          <About project={project} />
        </div>
      </div>
    </div>
  );
}

function StartBox({ project }: { project: Project }): JSX.Element {
  const setActiveChatId = useGruntStore((s) => s.setActiveChatId);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A chat made by a try whose message didn't send: the retry sends into it.
  const [pending, setPending] = useState<Chat | null>(null);

  async function send(): Promise<void> {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const chat = await startChat({ projectId: project.id, ...(pending ? { chat: pending } : {}), text: body });
      setPending(null);
      setText('');
      setActiveChatId(chat.id); // this pane has focus (the user typed here), so the chat replaces the page in it
    } catch (err) {
      if (err instanceof StartChatError) setPending(err.chat);
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

function ProjectChats({ projectId }: { projectId: string }): JSX.Element {
  const chats = useGruntStore((s) => s.chats);
  const projects = useGruntStore((s) => s.projects);
  const setActiveChatId = useGruntStore((s) => s.setActiveChatId);
  const { waiting, working } = useChatActivity();
  // The sidebar's own grouping, so the page and the sidebar always agree on order.
  const listed = useMemo(() => {
    const group = buildSidebar(chats, projects, null).groups.find((g) => g.key === projectId);
    return group ? [...group.pinnedChats, ...group.chats] : [];
  }, [chats, projects, projectId]);

  return (
    <section data-testid="home-chats" aria-label="Chats">
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
    <div className="space-y-4">
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
      {view.memory.body.trim() ? <Clamped text={view.memory.body} /> : <p className={EMPTY}>No memory yet</p>}
      <p className="text-xs text-[var(--text-faint)]">{memoryUpdatedLine(view.memory, chats)}</p>
    </div>
  );
}

/** Text kept as written, cut to a few lines with Show more when it runs long. */
function Clamped({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const long = text.split('\n').length > CLAMP_LINES || text.length > CLAMP_CHARS;
  return (
    <div>
      <p className={`whitespace-pre-wrap text-sm ${long && !open ? 'line-clamp-8' : ''}`}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-xs text-[var(--accent)] hover:underline">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
