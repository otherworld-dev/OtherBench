import { useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { compareProjects, PROJECT_DESCRIPTION_MAX, PROJECT_INSTRUCTIONS_MAX, PROJECT_NAME_MAX, projectLookup, projectParentOf } from '@otherbench/core/domain/projects.js';
import { folderPath } from '../components/FolderList.js';
import type { Project } from '@otherbench/core/ports/store.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { isDesktop, pickFolder } from '../desktop/bridge.js';
import { useServerPlatform } from '../lib/workspaceRoot.js';
import { ApiError, api } from '../state/api.js';
import { useOtherBenchStore, type ProjectPageState } from '../state/store.js';
import { FolderDraftList } from './project/FolderDraftList.js';
import { awayFolderWhere } from './project/folders.js';
import { createBody, draftFromProject, draftProblem, emptyDraft, isDirty, patchBody, type ProjectDraft } from './project/draft.js';

const FIELD = 'w-full rounded-sm border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1.5 text-sm';
const LABEL = 'label-caps mb-1 block text-[var(--text-muted)]';
const HINT = 'mt-1 text-xs text-[var(--text-muted)]';
const CARD = 'space-y-3 rounded-sm border border-[var(--border)] bg-[var(--bg-raised)] p-3';

export interface ProjectViewProps {
  page: ProjectPageState;
  onClose: () => void;
}

/**
 * The project page (spec 2026-10-08-project-page-design §3): a full-window
 * overlay like Settings that creates a project with everything it has, or
 * edits one. Nothing is sent until Create/Save.
 */
export function ProjectView({ page, onClose }: ProjectViewProps): JSX.Element {
  const project = useOtherBenchStore((s) => (page.mode === 'edit' ? (s.projects.find((p) => p.id === page.projectId) ?? null) : null));
  if (page.mode === 'edit' && !project) return <MissingProject onClose={onClose} />;
  const parentId = page.mode === 'create' ? page.parentId : undefined;
  return <ProjectForm project={project} parentId={parentId} returnFocus={page.returnFocus} onClose={onClose} />;
}

/**
 * For a project whose main folder isn't on this machine (another machine's
 * path, or a location not set up here): where it is, so the empty field
 * doesn't read as "no folder", and what typing one would do.
 */
function awayFolderNote(project: Project | null): string | null {
  const where = awayFolderWhere(project);
  return where === null ? null : `${where} A path typed here replaces it for every machine.`;
}

function MissingProject({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div data-testid="project-view" className="fixed inset-0 z-30 flex flex-col bg-[var(--bg)]">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3">
        <h2 className="label-caps text-base">Project settings</h2>
        <span className="flex-1" />
        <button type="button" onClick={onClose} className="btn px-2.5 py-1">
          Close
        </button>
      </div>
      <p className="p-6 text-sm text-[var(--text-muted)]">This project no longer exists. It may have been deleted in another tab or on another machine.</p>
    </div>
  );
}

/** A value a sub-project's chats get from its parent, shown under the field it adds to or stands in for. */
function Inherited({ testId, children }: { testId: string; children: string }): JSX.Element {
  return (
    <p data-testid={testId} className="mt-1 text-xs whitespace-pre-wrap text-[var(--text-faint)]">
      {children}
    </p>
  );
}

/**
 * `project` null: creating one, as a sub-project of `parentId` when given. The
 * form starts from the project as the page opened on it. `returnFocus` is
 * where focus goes on close when the element that opened the page is gone.
 */
function ProjectForm({ project, parentId, returnFocus, onClose }: { project: Project | null; parentId?: string | undefined; returnFocus?: string | undefined; onClose: () => void }): JSX.Element {
  const profiles = useOtherBenchStore((s) => s.profiles);
  const projects = useOtherBenchStore((s) => s.projects);
  const upsertProject = useOtherBenchStore((s) => s.upsertProject);
  const serverPlatform = useServerPlatform();
  const [initial] = useState<ProjectDraft>(() => (project ? draftFromProject(project) : emptyDraft(parentId)));
  const [draft, setDraft] = useState<ProjectDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Focus goes back to whatever opened the page (the + New project button, the
  // Inspector's Project settings…), else to `returnFocus` (a menu item is gone by then).
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  // Where focus was when the discard question opened, to put it back if the question is dismissed.
  const beforeQuestion = useRef<HTMLElement | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  const creating = project === null;
  const canPick = isDesktop();
  const live = profiles.filter((p) => p.archivedAt === null);
  const instructionsOver = draft.instructions.length > PROJECT_INSTRUCTIONS_MAX;
  const awayNote = awayFolderNote(project);
  // Spec 2026-10-15-sub-projects-design §5: any other top-level project can be the parent, and one with
  // sub-projects of its own (as the server counts them) can't go under another.
  const lookup = projectLookup(projects);
  const candidates = [...projects].sort(compareProjects).filter((p) => p.id !== project?.id && projectParentOf(p, lookup) === null);
  const hasChildren = project !== null && projects.some((p) => p.parentId === project.id);
  const parent = candidates.find((p) => p.id === draft.parentId) ?? null;
  const parentProfile = parent?.defaultProfileId ? live.find((p) => p.id === parent.defaultProfileId) : undefined;
  const parentFolders = (parent?.folderViews ?? []).map(folderPath);

  function set<K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function close(): void {
    const el = opener.current;
    onClose();
    setTimeout(() => {
      const target = el?.isConnected ? el : returnFocus ? document.querySelector<HTMLElement>(returnFocus) : null;
      target?.focus();
    }, 0);
  }

  function requestClose(): void {
    if (isDirty(initial, draft)) {
      beforeQuestion.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmDiscard(true);
    } else {
      close();
    }
  }

  /** The question was dismissed: keep editing, with focus back where it was so Esc and Tab still work here. */
  function keepEditing(): void {
    setConfirmDiscard(false);
    const el = beforeQuestion.current;
    setTimeout(() => (el?.isConnected ? el : nameInput.current)?.focus(), 0);
  }

  async function submit(): Promise<void> {
    if (saving) return;
    const problem = draftProblem(draft, serverPlatform);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (project === null) {
        upsertProject(await api.projects.create(createBody(draft)));
      } else {
        const body = patchBody(initial, draft);
        if (Object.keys(body).length > 0) upsertProject(await api.projects.patch(project.id, body));
      }
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the project. Please try again.");
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    // The discard question handles its own Esc (and marks it handled): that Esc only closes the question.
    if (e.key !== 'Escape' || e.defaultPrevented || confirmDiscard) return;
    e.preventDefault();
    requestClose();
  }

  return (
    <div data-testid="project-view" onKeyDown={onKeyDown} className="fixed inset-0 z-30 flex flex-col bg-[var(--bg)]">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3">
        <h2 className="label-caps text-base">{creating ? 'New project' : 'Project settings'}</h2>
        <span className="flex-1" />
        <button type="button" onClick={requestClose} className="btn px-2.5 py-1">
          Cancel
        </button>
        {/* aria-disabled while saving, not disabled: a disabled button drops keyboard focus, and a refusal leaves the user here. */}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={instructionsOver}
          aria-disabled={saving || undefined}
          className="btn btn-primary px-2.5 py-1"
        >
          {saving ? 'Saving…' : creating ? 'Create project' : 'Save'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <p role="alert" className="mx-auto max-w-5xl px-6 pt-4 text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="mx-auto grid max-w-5xl gap-7 p-6 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="space-y-4">
            <div>
              <label htmlFor="project-name" className={LABEL}>
                Name
              </label>
              <input ref={nameInput} id="project-name" autoFocus value={draft.name} maxLength={PROJECT_NAME_MAX} onChange={(e) => set('name', e.target.value)} className={FIELD} />
            </div>
            <div>
              <label htmlFor="project-parent" className={LABEL}>
                Parent
              </label>
              <select
                id="project-parent"
                value={parent ? draft.parentId : ''}
                disabled={hasChildren}
                onChange={(e) => set('parentId', e.target.value)}
                className={FIELD}
              >
                <option value="">None (top level)</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className={HINT}>
                {hasChildren
                  ? "This project has sub-projects, so it can't go under another one."
                  : "A sub-project's chats also get its parent's instructions, folders and memory."}
              </p>
            </div>
            <div>
              <label htmlFor="project-description" className={LABEL}>
                Description
              </label>
              <input
                id="project-description"
                value={draft.description}
                maxLength={PROJECT_DESCRIPTION_MAX}
                onChange={(e) => set('description', e.target.value)}
                className={FIELD}
              />
              <p className={HINT}>Shown in the Inspector, and in the list of your projects that every chat gets (unless its profile has global memory off).</p>
            </div>
            <div>
              <label htmlFor="project-instructions" className={LABEL}>
                Instructions
              </label>
              <textarea
                id="project-instructions"
                rows={14}
                value={draft.instructions}
                onChange={(e) => set('instructions', e.target.value)}
                className={`${FIELD} resize-y font-mono text-xs leading-relaxed`}
              />
              <div className="mt-1 flex items-start gap-3">
                <p className="flex-1 text-xs text-[var(--text-muted)]">
                  Added to the system prompt of every chat in this project, for every model, including Claude Code. The model follows these.
                </p>
                <span data-testid="instructions-count" className={`shrink-0 font-mono text-xs ${instructionsOver ? 'text-[var(--danger)]' : 'text-[var(--text-faint)]'}`}>
                  {draft.instructions.length.toLocaleString('en-US')} / {PROJECT_INSTRUCTIONS_MAX.toLocaleString('en-US')}
                </span>
              </div>
              {parent && parent.instructions.trim() !== '' && (
                <Inherited testId="inherited-instructions">{`From ${parent.name}, sent before these:\n${parent.instructions.trim()}`}</Inherited>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className={CARD}>
              <div>
                <label htmlFor="project-folder" className={LABEL}>
                  Main folder
                </label>
                <div className="flex gap-2">
                  <input
                    id="project-folder"
                    value={draft.folder}
                    onChange={(e) => set('folder', e.target.value)}
                    placeholder={serverPlatform === 'win32' ? 'E:\\Git\\OtherBench' : '/home/user/project'}
                    className={`${FIELD} font-mono text-xs`}
                  />
                  {canPick && (
                    <button
                      type="button"
                      onClick={() => {
                        void pickFolder('Choose the project folder').then((picked) => {
                          if (picked) set('folder', picked);
                        });
                      }}
                      className="btn shrink-0 px-2 py-1"
                    >
                      Choose…
                    </button>
                  )}
                  {draft.folder !== '' && (
                    <button type="button" onClick={() => set('folder', '')} className="btn shrink-0 px-2 py-1">
                      Clear
                    </button>
                  )}
                </div>
                {awayNote && (
                  <p data-testid="project-folder-away" className="mt-1 text-xs text-[var(--warn)]">
                    {awayNote}
                  </p>
                )}
                <p className={HINT}>New chats in this project start here. Existing chats keep theirs.</p>
                {parent?.workspaceRoot && draft.folder.trim() === '' && (
                  <Inherited testId="inherited-folder">{`Empty, so new chats start in ${parent.name}'s folder: ${parent.workspaceRoot}`}</Inherited>
                )}
              </div>
              <div>
                <span className={LABEL}>Other folders</span>
                <FolderDraftList folders={draft.folders} onChange={(folders) => set('folders', folders)} canPick={canPick} />
                <p className={HINT}>Every chat in this project can also use these.</p>
                {parent && parentFolders.length > 0 && <Inherited testId="inherited-folders">{`Also from ${parent.name}: ${parentFolders.join(', ')}`}</Inherited>}
              </div>
            </div>

            <div className={CARD}>
              <div>
                <label htmlFor="project-default-profile" className={LABEL}>
                  Default profile
                </label>
                <select
                  id="project-default-profile"
                  value={live.some((p) => p.id === draft.defaultProfileId) ? draft.defaultProfileId : ''}
                  onChange={(e) => set('defaultProfileId', e.target.value)}
                  className={FIELD}
                >
                  <option value="">App default</option>
                  {live.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className={HINT}>New chats in this project start with it.</p>
                {parentProfile && draft.defaultProfileId === '' && parent && (
                  <Inherited testId="inherited-profile">{`App default here means ${parent.name}'s default: ${parentProfile.name}`}</Inherited>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          message={creating ? "The project won't be created." : 'Your changes to this project will be lost.'}
          confirmLabel="Discard"
          onConfirm={async () => close()}
          onCancel={keepEditing}
        />
      )}
    </div>
  );
}
