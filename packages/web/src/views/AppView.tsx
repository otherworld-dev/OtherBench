import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { APP_NAME_MAX, isGithubRepo } from '@otherbench/core/domain/apps.js';
import { compareProjects, projectDisplayName, projectLookup, projectParentOf } from '@otherbench/core/domain/projects.js';
import type { App, Project } from '@otherbench/core/ports/store.js';
import { DEFAULT_COLLECTIVE, type ProjectLinksSuggestion } from '@otherbench/core/types/nextcloud.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { isDesktop, pickFolder } from '../desktop/bridge.js';
import { useServerPlatform, validateWorkspaceRoot } from '../lib/workspaceRoot.js';
import { ApiError, api, type CreateAppBody, type PatchAppBody } from '../state/api.js';
import { useOtherBenchStore, type AppPageState } from '../state/store.js';

const FIELD = 'w-full rounded-sm border border-[var(--border-strong)] bg-[var(--bg)] px-2 py-1.5 text-sm';
const LABEL = 'label-caps mb-1 block text-[var(--text-muted)]';
const HINT = 'mt-1 text-xs text-[var(--text-muted)]';

export interface AppViewProps {
  page: AppPageState;
  onClose: () => void;
}

/** A path's last segment, by either separator and ignoring trailing ones: what a new app is named after. */
export function folderName(path: string): string {
  const parts = path.trim().split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** The form's fields as typed. '' is "none" for the GitHub repo, the project and the profile. */
interface AppDraft {
  folder: string;
  name: string;
  githubRepo: string;
  linkedProjectId: string;
  defaultProfileId: string;
  /** A Deck board id as text; '' is none. */
  deckBoardId: string;
  wikiCollective: string;
  wikiPagePath: string;
  bookmarkTag: string;
}

function draftFromApp(app: App | null): AppDraft {
  return {
    folder: app?.workspaceRoot ?? '',
    name: app?.name ?? '',
    githubRepo: app?.githubRepo ?? '',
    linkedProjectId: app?.linkedProjectId ?? '',
    defaultProfileId: app?.defaultProfileId ?? '',
    deckBoardId: app?.deckBoardId == null ? '' : String(app.deckBoardId),
    wikiCollective: app?.wikiCollective ?? '',
    wikiPagePath: app?.wikiPagePath ?? '',
    bookmarkTag: app?.bookmarkTag ?? '',
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

type LinkField = 'deckBoardId' | 'wikiCollective' | 'wikiPagePath' | 'bookmarkTag';

/** What CLAUDE.md suggests, as draft fields. Only what it names; a field it says nothing about is left out. */
function linksPatch(s: ProjectLinksSuggestion, skip: (field: LinkField) => boolean): Partial<Pick<AppDraft, LinkField>> {
  const patch: Partial<Pick<AppDraft, LinkField>> = {};
  if (s.deckBoardId !== null && !skip('deckBoardId')) patch.deckBoardId = String(s.deckBoardId);
  const collective = s.collective ?? (s.pagePath ? DEFAULT_COLLECTIVE : null);
  if (collective && !skip('wikiCollective')) patch.wikiCollective = collective;
  if (s.pagePath && !skip('wikiPagePath')) patch.wikiPagePath = s.pagePath;
  if (s.bookmarkTag && !skip('bookmarkTag')) patch.bookmarkTag = s.bookmarkTag;
  return patch;
}

/**
 * The app form (spec 2026-10-20-code-tab-design, "Creating an app"): a
 * full-window overlay like the project page, for a new app ("+ New app" in
 * Code mode) or for editing one (its menu's Edit…). Nothing is sent until
 * Create/Save.
 */
export function AppView({ page, onClose }: AppViewProps): JSX.Element {
  const app = useOtherBenchStore((s) => (page.mode === 'edit' ? (s.apps.find((a) => a.id === page.appId) ?? null) : null));
  if (page.mode === 'edit' && !app) return <MissingApp onClose={onClose} />;
  return <AppForm app={app} returnFocus={page.returnFocus} onClose={onClose} />;
}

function MissingApp({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div data-testid="app-view" className="fixed inset-0 z-30 flex flex-col bg-[var(--bg)]">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3">
        <h2 className="label-caps text-base">Edit app</h2>
        <span className="flex-1" />
        <button type="button" onClick={onClose} className="btn px-2.5 py-1">
          Close
        </button>
      </div>
      <p className="p-6 text-sm text-[var(--text-muted)]">This app no longer exists. It may have been deleted in another tab or on another machine.</p>
    </div>
  );
}

/**
 * `app` null: creating one. The folder is required (an app is one repo). When
 * the folder changes (picked, or typed and the field left) its GitHub repo is
 * looked up and filled in, and a new app is named after the folder, but never
 * over a value the user typed into that field themselves.
 */
function AppForm({ app, returnFocus, onClose }: { app: App | null; returnFocus?: string | undefined; onClose: () => void }): JSX.Element {
  const profiles = useOtherBenchStore((s) => s.profiles);
  const projects = useOtherBenchStore((s) => s.projects);
  const upsertApp = useOtherBenchStore((s) => s.upsertApp);
  const openAppHome = useOtherBenchStore((s) => s.openAppHome);
  const serverPlatform = useServerPlatform();
  const [initial] = useState<AppDraft>(() => draftFromApp(app));
  const [draft, setDraft] = useState<AppDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Fields the user has typed in: a detected repo or the folder's name never replaces what they wrote.
  const typed = useRef({ name: app !== null, githubRepo: false, deckBoardId: false, wikiCollective: false, wikiPagePath: false, bookmarkTag: false });
  // The folder last looked up, so leaving the field unchanged doesn't ask again; and a counter so a slow answer
  // for an earlier folder can't land over a later one's.
  const detectedFor = useRef(initial.folder);
  const detectSeq = useRef(0);
  // The latest lookup while it runs. It answers with the repo it filled in, or undefined when it filled in nothing.
  const pendingDetect = useRef<Promise<string | undefined> | null>(null);
  // The same for CLAUDE.md's Nextcloud links: answers with the fields it filled in.
  const pendingLinks = useRef<Promise<Partial<AppDraft> | undefined> | null>(null);
  const linksSeq = useRef(0);
  const [boards, setBoards] = useState<{ id: number; title: string }[] | null>(null);
  const [boardsFailed, setBoardsFailed] = useState(false);
  // Null until Nextcloud has answered (and when it couldn't): a suggested collective can only be checked against a list.
  const [collectives, setCollectives] = useState<string[] | null>(null);
  const collectivesRef = useRef<string[] | null>(null);
  // A collective (and page path) CLAUDE.md suggested before the list had loaded, checked once it has.
  const unverifiedCollective = useRef<{ collective: string; pagePath: string | undefined } | null>(null);
  const [boardNotFound, setBoardNotFound] = useState<string | null>(null);
  const [collectiveNotFound, setCollectiveNotFound] = useState<string | null>(null);
  const [linksFailed, setLinksFailed] = useState(false);
  // The chosen collective's page paths, to pick the Collectives page from; null while loading or when Nextcloud couldn't say.
  const [collectivePages, setCollectivePages] = useState<{ collective: string; paths: string[] } | null>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const beforeQuestion = useRef<HTMLElement | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const creating = app === null;
  const canPick = isDesktop();
  const live = profiles.filter((p) => p.archivedAt === null);
  // Sidebar order, each sub-project after its parent and named "Parent / Child".
  const lookup = projectLookup(projects);
  const sorted = [...projects].sort(compareProjects);
  const parentOf = (p: Project): string | null => projectParentOf(p, lookup)?.id ?? null;
  const orderedProjects = sorted.filter((p) => parentOf(p) === null).flatMap((p) => [p, ...sorted.filter((c) => parentOf(c) === p.id)]);
  const linkedListed = orderedProjects.some((p) => p.id === draft.linkedProjectId);

  const chosenCollective = draft.wikiCollective.trim();
  useEffect(() => {
    setCollectivePages(null);
    if (chosenCollective === '') return;
    let live = true;
    api.nextcloud.collectivePages(chosenCollective).then(
      (paths) => live && setCollectivePages({ collective: chosenCollective, paths }),
      // No list: the path can still be typed, as before.
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [chosenCollective]);

  useEffect(() => {
    let live = true;
    api.nextcloud.boards().then(
      (b) => live && setBoards(b),
      () => live && setBoardsFailed(true)
    );
    api.nextcloud.collectives().then(
      (c) => {
        if (!live) return;
        collectivesRef.current = c;
        setCollectives(c);
        // A suggestion that landed first is taken back out if Nextcloud hasn't got that collective, unless it's been changed since.
        const u = unverifiedCollective.current;
        unverifiedCollective.current = null;
        if (u && !c.includes(u.collective)) {
          setCollectiveNotFound(u.collective);
          setDraft((d) =>
            d.wikiCollective !== u.collective
              ? d
              : { ...d, wikiCollective: '', wikiPagePath: u.pagePath !== undefined && d.wikiPagePath === u.pagePath ? '' : d.wikiPagePath }
          );
        }
      },
      () => {
        // The select keeps the stored collective as its only option, and a suggested one can't be checked.
      }
    );
    return () => {
      live = false;
    };
  }, []);

  function set<K extends keyof AppDraft>(key: K, value: AppDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  /**
   * Ask the server what the folder's CLAUDE.md says about Nextcloud and fill it in. Creating leaves fields the user typed
   * in alone; the Fill button (`overwrite`) replaces them. Answers with what it filled in, or undefined.
   */
  function fillLinks(path: string, overwrite: boolean): Promise<Partial<AppDraft> | undefined> {
    const seq = ++linksSeq.current;
    const lookup = (async (): Promise<Partial<AppDraft> | undefined> => {
      try {
        const suggestion = await api.nextcloud.detectLinks(path);
        if (seq !== linksSeq.current) return undefined;
        setLinksFailed(false);
        const patch = linksPatch(suggestion, (f) => !overwrite && typed.current[f]);
        setBoardNotFound(suggestion.deckBoard !== null && suggestion.deckBoardId === null ? suggestion.deckBoard : null);
        // A collective is only a suggestion until Nextcloud's list has it (spec: never saved as if it were right).
        setCollectiveNotFound(null);
        unverifiedCollective.current = null;
        const collective = patch.wikiCollective;
        if (collective !== undefined) {
          const known = collectivesRef.current;
          if (known === null) {
            unverifiedCollective.current = { collective, pagePath: patch.wikiPagePath };
          } else if (!known.includes(collective)) {
            setCollectiveNotFound(collective);
            delete patch.wikiCollective;
            delete patch.wikiPagePath;
          }
        }
        setDraft((d) => ({ ...d, ...patch }));
        return patch;
      } catch (err) {
        console.error('[otherbench-web] failed to read the Nextcloud links for', path, err);
        // Said only when asked for with the button; creating just leaves the fields as they are.
        if (seq === linksSeq.current && overwrite) setLinksFailed(true);
        return undefined;
      }
    })();
    pendingLinks.current = lookup;
    void lookup.then(() => {
      if (pendingLinks.current === lookup) pendingLinks.current = null;
    });
    return lookup;
  }

  /** The folder changed: name a new app after it, and look up its GitHub repo (spec: "auto-filled from the folder's git remotes"). */
  async function folderChanged(folder: string): Promise<void> {
    const path = folder.trim();
    if (path === detectedFor.current) return;
    detectedFor.current = path;
    if (!typed.current.name && path !== '') set('name', folderName(path).slice(0, APP_NAME_MAX));
    if (path === '' || validateWorkspaceRoot(path, serverPlatform) !== null) return;
    if (creating) void fillLinks(path, false);
    const seq = ++detectSeq.current;
    const lookup = (async (): Promise<string | undefined> => {
      try {
        const { githubRepo } = await api.apps.detectRepo(path);
        if (seq !== detectSeq.current || typed.current.githubRepo) return undefined;
        set('githubRepo', githubRepo ?? '');
        return githubRepo ?? '';
      } catch (err) {
        // A folder that isn't there yet is the server's to refuse on Create; the repo just stays as it is.
        console.error('[otherbench-web] failed to look up the GitHub repo for', path, err);
        return undefined;
      }
    })();
    pendingDetect.current = lookup;
    await lookup;
    if (pendingDetect.current === lookup) pendingDetect.current = null;
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
    if (JSON.stringify(initial) !== JSON.stringify(draft)) {
      beforeQuestion.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirmDiscard(true);
    } else {
      close();
    }
  }

  function keepEditing(): void {
    setConfirmDiscard(false);
    const el = beforeQuestion.current;
    setTimeout(() => (el?.isConnected ? el : folderInput.current)?.focus(), 0);
  }

  /** The first thing to fix before sending, or null. The server is the hard gate; this is the friendlier early one. */
  function problem(d: AppDraft): string | null {
    const folder = d.folder.trim();
    // Editing an app whose folder isn't on this machine shows an empty field: left empty, the folder isn't changed.
    if (folder === '' && (creating || initial.folder !== '')) return "Choose the app's folder.";
    if (folder !== '') {
      const bad = validateWorkspaceRoot(folder, serverPlatform);
      if (bad) return bad;
    }
    const name = d.name.trim();
    if (name === '') return 'Give the app a name.';
    if (name.length > APP_NAME_MAX) return `The name can be at most ${APP_NAME_MAX} characters.`;
    const repo = d.githubRepo.trim();
    if (repo !== '' && !isGithubRepo(repo)) return 'The GitHub repo is "owner/name", such as otherworld-dev/OtherBench.';
    const collective = d.wikiCollective.trim();
    const page = d.wikiPagePath.trim();
    if (collective !== '' && page === '') return 'Give the Collectives page a path, or clear the collective.';
    if (collective === '' && page !== '') return 'Choose the collective for the Collectives page, or clear the path.';
    return null;
  }

  function createBody(d: AppDraft): CreateAppBody {
    return {
      name: d.name.trim(),
      workspacePath: d.folder.trim(),
      githubRepo: orNull(d.githubRepo),
      linkedProjectId: orNull(d.linkedProjectId),
      defaultProfileId: orNull(d.defaultProfileId),
      deckBoardId: d.deckBoardId === '' ? null : Number(d.deckBoardId),
      wikiCollective: orNull(d.wikiCollective),
      wikiPagePath: orNull(d.wikiPagePath),
      bookmarkTag: orNull(d.bookmarkTag),
    };
  }

  function patchBody(d: AppDraft): PatchAppBody {
    const body: PatchAppBody = {};
    if (d.name.trim() !== initial.name) body.name = d.name.trim();
    if (d.folder.trim() !== '' && d.folder.trim() !== initial.folder) body.workspacePath = d.folder.trim();
    if (d.githubRepo.trim() !== initial.githubRepo) body.githubRepo = orNull(d.githubRepo);
    if (d.linkedProjectId !== initial.linkedProjectId) body.linkedProjectId = orNull(d.linkedProjectId);
    if (d.defaultProfileId !== initial.defaultProfileId) body.defaultProfileId = orNull(d.defaultProfileId);
    if (d.deckBoardId !== initial.deckBoardId) body.deckBoardId = d.deckBoardId === '' ? null : Number(d.deckBoardId);
    if (d.wikiCollective.trim() !== initial.wikiCollective) body.wikiCollective = orNull(d.wikiCollective);
    if (d.wikiPagePath.trim() !== initial.wikiPagePath) body.wikiPagePath = orNull(d.wikiPagePath);
    if (d.bookmarkTag.trim() !== initial.bookmarkTag) body.bookmarkTag = orNull(d.bookmarkTag);
    return body;
  }

  async function submit(): Promise<void> {
    if (saving) return;
    setSaving(true);
    // A folder typed and then left by clicking Create/Save starts its repo lookup on that same click, so the
    // lookup is waited for and its answer sent, rather than racing it and saving without the repo (spec
    // 2026-10-20-code-tab-design, "Creating an app": the repo is auto-filled from the folder's git remotes).
    const detected = pendingDetect.current ? await pendingDetect.current : undefined;
    const links = pendingLinks.current ? await pendingLinks.current : undefined;
    const d = { ...draft, ...links, ...(detected === undefined ? {} : { githubRepo: detected }) };
    const why = problem(d);
    if (why) {
      setError(why);
      setSaving(false);
      return;
    }
    setError(null);
    try {
      if (app === null) {
        const created = await api.apps.create(createBody(d));
        upsertApp(created);
        close();
        // A new app has no chats yet: its home is where the first one starts.
        openAppHome(created.id);
        return;
      }
      const body = patchBody(d);
      if (Object.keys(body).length > 0) upsertApp(await api.apps.patch(app.id, body));
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the app. Please try again.");
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'Escape' || e.defaultPrevented || confirmDiscard) return;
    e.preventDefault();
    requestClose();
  }

  return (
    <div data-testid="app-view" onKeyDown={onKeyDown} className="fixed inset-0 z-30 flex flex-col bg-[var(--bg)]">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-raised)] px-4 py-3">
        <h2 className="label-caps text-base">{creating ? 'New app' : 'Edit app'}</h2>
        <span className="flex-1" />
        <button type="button" onClick={requestClose} className="btn px-2.5 py-1">
          Cancel
        </button>
        {/* aria-disabled while saving, not disabled: a disabled button drops keyboard focus, and a refusal leaves the user here. */}
        <button type="button" onClick={() => void submit()} aria-disabled={saving || undefined} className="btn btn-primary px-2.5 py-1">
          {saving ? 'Saving…' : creating ? 'Create app' : 'Save'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-xl space-y-4 p-6">
          {error && (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {error}
            </p>
          )}
          <div>
            <label htmlFor="app-folder" className={LABEL}>
              Folder
            </label>
            <div className="flex gap-2">
              <input
                ref={folderInput}
                id="app-folder"
                autoFocus={creating}
                value={draft.folder}
                onChange={(e) => set('folder', e.target.value)}
                onBlur={(e) => void folderChanged(e.target.value)}
                placeholder={serverPlatform === 'win32' ? 'E:\\Git\\OtherBench' : '/home/user/project'}
                className={`${FIELD} font-mono text-xs`}
              />
              {canPick && (
                <button
                  type="button"
                  onClick={() => {
                    void pickFolder("Choose the app's folder").then((picked) => {
                      if (!picked) return;
                      set('folder', picked);
                      void folderChanged(picked);
                    });
                  }}
                  className="btn shrink-0 px-2 py-1"
                >
                  Choose…
                </button>
              )}
            </div>
            {!creating && initial.folder === '' && (
              <p data-testid="app-folder-away" className="mt-1 text-xs text-[var(--warn)]">
                This app's folder isn't on this machine. A path typed here replaces it for every machine.
              </p>
            )}
            <p className={HINT}>The repo's folder. Every chat in the app works here{creating ? '' : ', and changing it moves them all'}.</p>
          </div>

          <div>
            <label htmlFor="app-name" className={LABEL}>
              Name
            </label>
            <input
              id="app-name"
              // Editing starts here (creating starts at Folder): something in the form must hold focus, or Escape,
              // which the form listens for, would go to the page behind it and do nothing.
              autoFocus={!creating}
              value={draft.name}
              maxLength={APP_NAME_MAX}
              onChange={(e) => {
                typed.current.name = true;
                set('name', e.target.value);
              }}
              className={FIELD}
            />
          </div>

          <div>
            <label htmlFor="app-github" className={LABEL}>
              GitHub repo
            </label>
            <input
              id="app-github"
              value={draft.githubRepo}
              onChange={(e) => {
                typed.current.githubRepo = true;
                set('githubRepo', e.target.value);
              }}
              placeholder="owner/name"
              className={`${FIELD} font-mono text-xs`}
            />
            <p data-testid="app-github-hint" className={HINT}>
              {draft.githubRepo.trim() === '' ? 'No GitHub repo set for this app' : 'Its issues show in the Issues tab.'}
            </p>
          </div>

          <div>
            <label htmlFor="app-deck-board" className={LABEL}>
              Deck board
            </label>
            <select
              id="app-deck-board"
              value={draft.deckBoardId}
              disabled={boardsFailed}
              onChange={(e) => {
                typed.current.deckBoardId = true;
                setBoardNotFound(null);
                set('deckBoardId', e.target.value);
              }}
              className={FIELD}
            >
              <option value="">None</option>
              {draft.deckBoardId !== '' && !boards?.some((b) => String(b.id) === draft.deckBoardId) && (
                <option value={draft.deckBoardId}>Board {draft.deckBoardId}</option>
              )}
              {boards?.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.title}
                </option>
              ))}
            </select>
            {boardsFailed && <p className={HINT}>Set up Nextcloud in Settings to pick a board.</p>}
            {/* Without Nextcloud no board could be looked up, so a name that didn't resolve isn't "not found". */}
            {boardNotFound !== null && !boardsFailed && (
              <p data-testid="app-board-not-found" className="mt-1 text-xs text-[var(--warn)]">
                CLAUDE.md names the board "{boardNotFound}", which wasn't found.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="app-wiki-collective" className={LABEL}>
              Collectives page
            </label>
            <div className="flex gap-2">
              <select
                id="app-wiki-collective"
                value={draft.wikiCollective}
                onChange={(e) => {
                  typed.current.wikiCollective = true;
                  setCollectiveNotFound(null);
                  set('wikiCollective', e.target.value);
                }}
                className={`${FIELD} w-auto shrink-0`}
              >
                <option value="">None</option>
                {draft.wikiCollective !== '' && !(collectives ?? []).includes(draft.wikiCollective) && <option value={draft.wikiCollective}>{draft.wikiCollective}</option>}
                {(collectives ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                aria-label="Collectives page path"
                value={draft.wikiPagePath}
                onChange={(e) => {
                  typed.current.wikiPagePath = true;
                  set('wikiPagePath', e.target.value);
                }}
                placeholder="Products/MyApp"
                className={FIELD}
              />
            </div>
            {collectivePages && collectivePages.collective === chosenCollective && collectivePages.paths.length > 0 && (
              <select
                aria-label={`Pick a page in ${chosenCollective}`}
                value={collectivePages.paths.includes(draft.wikiPagePath.trim()) ? draft.wikiPagePath.trim() : ''}
                onChange={(e) => {
                  if (e.target.value === '') return;
                  typed.current.wikiPagePath = true;
                  set('wikiPagePath', e.target.value);
                }}
                className={`${FIELD} mt-1`}
              >
                <option value="">Pick a page in {chosenCollective}…</option>
                {collectivePages.paths.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
            {collectiveNotFound !== null && (
              <p data-testid="app-collective-not-found" className="mt-1 text-xs text-[var(--warn)]">
                CLAUDE.md names the collective "{collectiveNotFound}", which wasn't found.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="app-bookmark-tag" className={LABEL}>
              Bookmark tag
            </label>
            <input
              id="app-bookmark-tag"
              value={draft.bookmarkTag}
              onChange={(e) => {
                typed.current.bookmarkTag = true;
                set('bookmarkTag', e.target.value);
              }}
              className={FIELD}
            />
            {!creating && (
              <button
                type="button"
                onClick={() => void fillLinks(draft.folder.trim(), true)}
                disabled={draft.folder.trim() === '' || validateWorkspaceRoot(draft.folder.trim(), serverPlatform) !== null}
                className="btn mt-2 px-2 py-1"
              >
                Fill from CLAUDE.md
              </button>
            )}
            {linksFailed && (
              <p role="alert" className="mt-1 text-xs text-[var(--warn)]">
                Couldn't read CLAUDE.md from this folder.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="app-linked-project" className={LABEL}>
              Linked chat project
            </label>
            <select
              id="app-linked-project"
              value={linkedListed ? draft.linkedProjectId : ''}
              onChange={(e) => set('linkedProjectId', e.target.value)}
              className={FIELD}
            >
              <option value="">None</option>
              {orderedProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {projectDisplayName(p, lookup)}
                </option>
              ))}
            </select>
            <p className={HINT}>The app's chats also get this project's instructions, memory note and folders. They don't add to its memory.</p>
          </div>

          <div>
            <label htmlFor="app-default-profile" className={LABEL}>
              Default profile
            </label>
            <select
              id="app-default-profile"
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
            <p className={HINT}>New chats in this app, and chats moved into it, start with it.</p>
          </div>
        </div>
      </div>

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          message={creating ? "The app won't be created." : 'Your changes to this app will be lost.'}
          confirmLabel="Discard"
          onConfirm={async () => close()}
          onCancel={keepEditing}
        />
      )}
    </div>
  );
}
