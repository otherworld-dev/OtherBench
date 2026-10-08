import { useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { PROJECT_DESCRIPTION_MAX, PROJECT_INSTRUCTIONS_MAX, PROJECT_NAME_MAX } from '@grunt/core/domain/projects.js';
import type { Project } from '@grunt/core/ports/store.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { isDesktop, pickFolder } from '../desktop/bridge.js';
import { useServerPlatform } from '../lib/workspaceRoot.js';
import { ApiError, api } from '../state/api.js';
import { useGruntStore, type ProjectPageState } from '../state/store.js';
import { FolderDraftList } from './project/FolderDraftList.js';
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
  const project = useGruntStore((s) => (page.mode === 'edit' ? (s.projects.find((p) => p.id === page.projectId) ?? null) : null));
  if (page.mode === 'edit' && !project) return <MissingProject onClose={onClose} />;
  return <ProjectForm project={project} returnFocus={page.returnFocus} onClose={onClose} />;
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

/**
 * `project` null: creating one. The form starts from the project as the page
 * opened on it. `returnFocus` is where focus goes on close when the element
 * that opened the page is gone.
 */
function ProjectForm({ project, returnFocus, onClose }: { project: Project | null; returnFocus?: string; onClose: () => void }): JSX.Element {
  const profiles = useGruntStore((s) => s.profiles);
  const upsertProject = useGruntStore((s) => s.upsertProject);
  const serverPlatform = useServerPlatform();
  const [initial] = useState<ProjectDraft>(() => (project ? draftFromProject(project) : emptyDraft()));
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
              <p className={HINT}>For you, shown in the Inspector. Not sent to the model.</p>
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
                    placeholder={serverPlatform === 'win32' ? 'E:\\Git\\Grunt' : '/home/user/project'}
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
                <p className={HINT}>New chats in this project start here. Existing chats keep theirs.</p>
              </div>
              <div>
                <span className={LABEL}>Other folders</span>
                <FolderDraftList folders={draft.folders} onChange={(folders) => set('folders', folders)} canPick={canPick} />
                <p className={HINT}>Every chat in this project can also use these.</p>
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
