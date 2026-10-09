import { useEffect, useRef, useState, type JSX } from 'react';
import type { AboutOutcome, ImportPhase, ImportPreview, ImportReport, ImportStatus, MemoryOutcome } from '@grunt/core/types/claude-import.js';
import type { Project } from '@grunt/core/ports/store.js';
import type { Connection, Profile } from '@grunt/core/types/config.js';
import { isDesktop, pickFolder } from '../../desktop/bridge.js';
import { ApiError, api } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';

const HEADING = 'text-sm font-semibold';
const HINT = 'text-xs text-[var(--text-muted)]';
const INPUT = 'rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1';
/** How often the status is fetched while an import runs. */
export const IMPORT_POLL_MS = 1000;

const PHASE_LABEL: Record<ImportPhase, string> = {
  reading: 'Reading the export',
  projects: 'Importing projects',
  chats: 'Importing chats',
  artifacts: 'Importing published artifacts',
  cowork: 'Importing Cowork sessions',
  memory: 'Condensing memory',
};

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The profile imported chats start on: a Claude one (Claude Code or the Anthropic API) if there is one, else the default, else the first. */
export function defaultImportProfileId(profiles: Profile[], connections: Connection[]): string {
  const live = profiles.filter((p) => p.archivedAt === null);
  const kindOf = (p: Profile) => connections.find((c) => c.id === p.connectionId)?.kind;
  const claude = live.find((p) => kindOf(p) === 'claude_code' || kindOf(p) === 'anthropic');
  return (claude ?? live.find((p) => p.isDefault) ?? live[0])?.id ?? '';
}

function hasMemory(preview: ImportPreview): boolean {
  return preview.memory.about || preview.memory.note || preview.memory.projectNotes > 0;
}

/** The server doesn't announce projects as it makes them, so the sidebar's are fetched again once an import ends; chats come too. */
function refreshAfterImport(): void {
  const { setProjects, setChats } = useGruntStore.getState();
  Promise.all([api.projects.list(), api.chats.list()])
    .then(([projects, chats]) => {
      setProjects(projects);
      setChats(chats);
    })
    .catch((err: unknown) => console.error('[grunt-web] failed to reload after the import:', err));
}

/**
 * Settings > Import (spec 2026-10-09-claude-import-design §6): choose the
 * folder a claude.ai export was downloaded to, check what importing it would
 * do, then run it and watch it go. Chats appear in the sidebar as they land,
 * through the app-wide events.
 */
export function ImportPanel(): JSX.Element {
  const profiles = useGruntStore((s) => s.profiles);
  const connections = useGruntStore((s) => s.connections);
  const projects = useGruntStore((s) => s.projects);
  const [folder, setFolder] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [memory, setMemory] = useState(true);
  const [cowork, setCowork] = useState(false);
  /** Each Cowork space's project, '' for No project. */
  const [spaces, setSpaces] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = status?.state === 'running';

  useEffect(() => {
    if (!profileId) setProfileId(defaultImportProfileId(profiles, connections));
  }, [profiles, connections, profileId]);

  useEffect(() => {
    let cancelled = false;
    api.claudeImport
      .status()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch((err: unknown) => console.error('[grunt-web] failed to load the import status:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      api.claudeImport
        .status()
        .then(setStatus)
        .catch((err: unknown) => console.error('[grunt-web] failed to load the import status:', err));
    }, IMPORT_POLL_MS);
    return () => clearInterval(timer);
  }, [running]);

  // Once an import this panel watched ends, the sidebar gets the projects it made.
  const previousState = useRef<ImportStatus['state'] | null>(null);
  useEffect(() => {
    const state = status?.state ?? null;
    if (previousState.current === 'running' && state !== 'running') refreshAfterImport();
    previousState.current = state;
  }, [status?.state]);

  async function check(): Promise<void> {
    setChecking(true);
    setError(null);
    setPreview(null);
    try {
      const next = await api.claudeImport.preview(folder.trim(), profileId || null);
      setPreview(next);
      setMemory(next.memoryModel !== null && hasMemory(next));
      setCowork(false);
      setSpaces({});
    } catch (err) {
      setError(errorText(err, "Couldn't read that folder -- please try again."));
    } finally {
      setChecking(false);
    }
  }

  async function start(from: ImportPreview): Promise<void> {
    setStarting(true);
    setError(null);
    try {
      const chosen = Object.fromEntries(Object.entries(spaces).map(([space, project]) => [space, project || null]));
      setStatus(await api.claudeImport.start({ folder: from.folder, profileId, memory, cowork, spaces: chosen }));
      setPreview(null);
    } catch (err) {
      setError(errorText(err, "The import didn't start -- please try again."));
    } finally {
      setStarting(false);
    }
  }

  async function browse(): Promise<void> {
    const picked = await pickFolder('Choose the folder with the claude.ai export');
    if (picked) {
      setFolder(picked);
      setPreview(null);
    }
  }

  return (
    <section className="max-w-2xl space-y-6 text-sm">
      <div className="space-y-2">
        <h3 className={HEADING}>Import from claude.ai</h3>
        <p className={HINT}>
          Brings your claude.ai chats, projects, published artifacts and memory into Grunt, and if you like the Cowork sessions Claude Desktop keeps on this
          machine. On claude.ai, open Settings &rarr; Privacy and choose Export data. When
          the email arrives, download every file into one folder (the ZIPs, or what&rsquo;s in them) and choose that folder here. Importing the same export again
          skips what&rsquo;s already here.
        </p>
      </div>

      {!running && (
        <div className="space-y-2">
          <label className="flex flex-col gap-1">
            Export folder
            <span className="flex gap-2">
              <input
                aria-label="Export folder"
                value={folder}
                placeholder="The full path of the folder"
                onChange={(e) => {
                  setFolder(e.target.value);
                  setPreview(null);
                }}
                className={`${INPUT} flex-1 font-mono text-xs`}
              />
              {isDesktop() && (
                <button type="button" onClick={() => void browse()} className="btn px-2.5 py-1">
                  Choose folder&hellip;
                </button>
              )}
              <button type="button" onClick={() => void check()} disabled={!folder.trim() || checking} className="btn px-2.5 py-1">
                {checking ? 'Checking…' : 'Check folder'}
              </button>
            </span>
          </label>
        </div>
      )}

      {error && (
        <p data-testid="import-error" role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}

      {preview && !running && (
        <PreviewView
          preview={preview}
          profiles={profiles.filter((p) => p.archivedAt === null)}
          profileId={profileId}
          onProfile={setProfileId}
          memory={memory}
          onMemory={setMemory}
          cowork={cowork}
          onCowork={setCowork}
          projects={projects}
          spaces={spaces}
          onSpace={(space, project) => setSpaces((current) => ({ ...current, [space]: project }))}
          starting={starting}
          onImport={() => void start(preview)}
        />
      )}

      {status && status.state !== 'idle' && <StatusView status={status} />}
    </section>
  );
}

interface PreviewProps {
  preview: ImportPreview;
  profiles: Profile[];
  profileId: string;
  onProfile: (id: string) => void;
  memory: boolean;
  onMemory: (on: boolean) => void;
  cowork: boolean;
  onCowork: (on: boolean) => void;
  projects: Project[];
  spaces: Record<string, string>;
  onSpace: (space: string, project: string) => void;
  starting: boolean;
  onImport: () => void;
}

function PreviewView({ preview, profiles, profileId, onProfile, memory, onMemory, cowork, onCowork, projects, spaces, onSpace, starting, onImport }: PreviewProps): JSX.Element {
  const { chats, memory: notes } = preview;
  const fresh = chats.total - chats.existing + (cowork && preview.cowork ? preview.cowork.sessions - preview.cowork.existing : 0);
  return (
    <div data-testid="import-preview" className="space-y-4 rounded border border-[var(--border)] p-3">
      <ul className="list-disc space-y-1 pl-5">
        <li>
          {count(chats.total, 'chat')} ({count(chats.messages, 'message')}
          {chats.branched > 0 ? `, ${chats.branched.toLocaleString('en-US')} with more than one branch` : ''})
          {chats.existing > 0 ? `; ${chats.existing.toLocaleString('en-US')} already imported, which will be skipped` : ''}
        </li>
        {chats.newer > 0 && (
          <li>
            {count(chats.newer, 'imported chat has', 'imported chats have')} newer messages on claude.ai, which a second import doesn&rsquo;t add
          </li>
        )}
        {preview.emptyChats > 0 && <li>{count(preview.emptyChats, 'empty conversation')} left out</li>}
        {preview.artifacts.length > 0 && <li>{count(preview.artifacts.length, 'published artifact')}, each in a chat of its own</li>}
        {preview.memoryChat && (
          <li>
            claude.ai&rsquo;s {count(preview.memoryChat.notes, 'memory note')}{' '}
            {preview.memoryChat.existing ? `are already in the chat “${preview.memoryChat.title}”` : `go into a chat of their own, “${preview.memoryChat.title}”, which recall can search`}
          </li>
        )}
        {preview.chatList.found && <li>{count(chats.filed, 'chat')} filed into {chats.filed === 1 ? 'its project' : 'their projects'}, from claude.ai&rsquo;s chat list</li>}
        {preview.projects.map((p) => (
          <li key={p.id}>
            Project &ldquo;{p.name}&rdquo;: {p.action === 'create' ? 'new' : p.action === 'merge' ? `merges into your project “${p.mergeInto ?? p.name}”` : 'already imported'}
            {p.docs > 0 ? `, ${count(p.docs, 'doc')}` : ''}
            {p.hasInstructions ? ', instructions' : ''}
            {p.hasMemory ? ', memory' : ''}
          </li>
        ))}
        {preview.filesNotIncluded > 0 && (
          <li>{count(preview.filesNotIncluded, 'image or file', 'images and files')} aren&rsquo;t in the export; each shows as a note in its chat</li>
        )}
      </ul>

      {!preview.chatList.found && (
        <p data-testid="chat-list-hint" className={HINT}>
          Chats go into No project: the export doesn&rsquo;t say which project each was in.{' '}
          {preview.chatList.url ? (
            <>
              To file them, open <span className="font-mono">{preview.chatList.url}</span> in a browser where you&rsquo;re logged into claude.ai, save the page as{' '}
              <span className="font-mono">chat_conversations.json</span> in this folder, and check the folder again.
            </>
          ) : (
            <>To file them, save claude.ai&rsquo;s chat list into this folder as <span className="font-mono">chat_conversations.json</span> and check the folder again.</>
          )}
        </p>
      )}

      {preview.cowork && (
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" aria-label="Import Cowork sessions" checked={cowork} onChange={(e) => onCowork(e.target.checked)} />
            Also import the {count(preview.cowork.sessions, 'Cowork session')} on this machine
            {preview.cowork.existing > 0 ? ` (${preview.cowork.existing.toLocaleString('en-US')} already imported)` : ''}
          </label>
          <p className={HINT}>
            {count(preview.cowork.messages, 'message')} and {count(preview.cowork.images, 'image')}, from <span className="font-mono">{preview.cowork.root}</span>.
          </p>
          {cowork &&
            preview.cowork.spaces.map((space) => (
              <label key={space.id} className="flex flex-wrap items-center gap-2">
                <span>
                  The space with {space.titles.map((t) => `“${t}”`).join(', ')}
                  {space.sessions > space.titles.length ? ` and ${space.sessions - space.titles.length} more` : ''} goes into
                </span>
                <select aria-label={`Project for the Cowork space with ${space.titles[0] ?? space.id}`} value={spaces[space.id] ?? ''} onChange={(e) => onSpace(space.id, e.target.value)} className={INPUT}>
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
        </div>
      )}

      <label className="flex items-center gap-2">
        Imported chats use
        <select aria-label="Profile for imported chats" value={profileId} onChange={(e) => onProfile(e.target.value)} className={INPUT}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p className={HINT}>Replies are labelled Claude &middot; claude.ai. Carrying on an imported chat uses this profile.</p>

      {hasMemory(preview) && (
        <div className="space-y-1">
          <label className="flex items-center gap-2">
            <input type="checkbox" aria-label="Condense memory" checked={memory} disabled={preview.memoryModel === null} onChange={(e) => onMemory(e.target.checked)} />
            {preview.memoryModel === null ? "Condense claude.ai's memory into Grunt's" : `Condense claude.ai's memory into Grunt's with ${preview.memoryModel}`}
          </label>
          <p className={HINT}>
            {preview.memoryModel === null
              ? 'No model can do this. Choose a Memory model under Settings → Memory first.'
              : [
                  notes.about ? "About you is drafted from claude.ai's notes for you to read and accept." : null,
                  notes.note ? 'The learned note is folded in.' : null,
                  notes.projectNotes > 0 ? `${count(notes.projectNotes, 'project note')} folded in.` : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
          </p>
        </div>
      )}
      {notes.files > 0 && (
        <p className={HINT}>
          claude.ai&rsquo;s {count(notes.files, 'memory file')} and the projects&rsquo; docs are kept in <span className="font-mono">{preview.importFolder}</span>.
        </p>
      )}

      <button type="button" onClick={onImport} disabled={!profileId || starting} className="btn btn-primary px-2.5 py-1">
        {starting ? 'Starting…' : fresh > 0 ? `Import ${count(fresh, 'chat')}` : 'Import'}
      </button>
    </div>
  );
}

function StatusView({ status }: { status: ImportStatus }): JSX.Element {
  if (status.state === 'running') {
    return (
      <div data-testid="import-status" className="space-y-2">
        <p role="status">
          {status.phase ? PHASE_LABEL[status.phase] : 'Importing'}&hellip; {status.done.toLocaleString('en-US')} of {status.total.toLocaleString('en-US')}
        </p>
        <progress aria-label="Import progress" max={Math.max(1, status.total)} value={status.done} className="w-full" />
        <p className={HINT}>Chats appear in the sidebar as they&rsquo;re imported.</p>
      </div>
    );
  }
  return (
    <div data-testid="import-report" className="space-y-2">
      <h3 className={HEADING}>{status.state === 'failed' ? 'The import stopped' : 'Import finished'}</h3>
      {status.error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {status.error}
        </p>
      )}
      {status.report && <ReportView report={status.report} />}
    </div>
  );
}

/**
 * The About you the memory model drafted from claude.ai's notes. It goes into
 * every chat as the user's own words, so nothing is saved until they read it
 * and choose to.
 */
function AboutDraft({ text }: { text: string }): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await api.memory.global.saveAbout(text);
      setSaved(true);
    } catch (err) {
      setError(errorText(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="about-draft" className="space-y-2 rounded border border-[var(--border)] p-3">
      <h4 className="text-sm font-semibold">About you, drafted from claude.ai&rsquo;s notes</h4>
      <p className={HINT}>
        Grunt adds About you to every chat as your own words, so read it first. Saving it replaces what Settings &rarr; Memory &rarr; About you holds now; you can
        edit it there afterwards.
      </p>
      <pre className="whitespace-pre-wrap rounded bg-[var(--bg-sunken)] p-2 text-xs">{text}</pre>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving || saved} className="btn btn-primary px-2.5 py-1">
          {saving ? 'Saving…' : 'Save as About you'}
        </button>
        {saved && (
          <span role="status" className={HINT}>
            Saved.
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

function outcomeText(outcome: MemoryOutcome | AboutOutcome): string {
  return outcome.status === 'saved' ? 'saved' : outcome.status === 'drafted' ? 'drafted, below' : `${outcome.status}: ${outcome.reason}`;
}

function ReportView({ report }: { report: ImportReport }): JSX.Element {
  const failures = [...report.chats.failed, ...report.artifacts.failed, ...(report.cowork?.failed ?? []), ...report.projects.failed, ...report.fileErrors];
  const { projects, memory } = report;
  return (
    <div className="space-y-2">
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Imported {count(report.chats.imported, 'chat')} ({count(report.chats.messages, 'message')})
          {report.chats.existing > 0 ? `; ${report.chats.existing.toLocaleString('en-US')} were already here` : ''}
          {report.chats.newer > 0 ? `, ${report.chats.newer.toLocaleString('en-US')} of them with newer messages on claude.ai that weren't added` : ''}
        </li>
        {report.chats.filed > 0 && <li>Filed {count(report.chats.filed, 'chat')} into {report.chats.filed === 1 ? 'its project' : 'their projects'}</li>}
        {report.artifacts.imported + report.artifacts.existing > 0 && <li>Imported {count(report.artifacts.imported, 'published artifact')}</li>}
        {report.cowork && (
          <li>
            Imported {count(report.cowork.imported, 'Cowork session')} ({count(report.cowork.messages, 'message')}, {count(report.cowork.images, 'image')})
            {report.cowork.existing > 0 ? `; ${report.cowork.existing.toLocaleString('en-US')} were already here` : ''}
            {report.cowork.filed > 0 ? `; ${report.cowork.filed.toLocaleString('en-US')} filed into projects` : ''}
          </li>
        )}
        {projects.created.length > 0 && <li>New projects: {projects.created.join(', ')}</li>}
        {projects.merged.length > 0 && <li>Merged into your projects: {projects.merged.join(', ')}</li>}
        {report.docs.folders.map((f) => (
          <li key={f.path}>
            {f.project}&rsquo;s docs are in <span className="font-mono">{f.path}</span>
            {!f.attached
              ? ', not attached: the project has no room for another folder'
              : f.workspace
                ? ', attached to the project read-only'
                : ", attached to the project read-only; its chats see them once the project or chat has a workspace folder"}
          </li>
        ))}
        {memory && (
          <li>
            Memory{memory.model ? ` (with ${memory.model})` : ''}: About you {outcomeText(memory.about)}; learned note {outcomeText(memory.note)}
            {memory.projects.map((p) => `; ${p.name} ${outcomeText(p.outcome)}`).join('')}
          </li>
        )}
        {report.memoryChat && (
          <li>
            claude.ai&rsquo;s {count(report.memoryChat.notes, 'memory note')} {report.memoryChat.imported ? 'are' : 'were already'} in the chat &ldquo;{report.memoryChat.title}&rdquo;, which
            recall searches
          </li>
        )}
        {report.memoryFiles && (
          <li>
            claude.ai&rsquo;s memory files are in <span className="font-mono">{report.memoryFiles}</span>
          </li>
        )}
        {report.filesNotIncluded > 0 && <li>{count(report.filesNotIncluded, 'image or file', 'images and files')} weren&rsquo;t in the export</li>}
      </ul>
      {memory?.about.status === 'drafted' && <AboutDraft text={memory.about.text} />}
      {failures.length > 0 && (
        <div role="alert" className="space-y-1 text-xs text-[var(--danger)]">
          <p>These couldn&rsquo;t be imported:</p>
          <ul className="list-disc pl-5">
            {failures.map((f, i) => (
              <li key={i}>
                {f.title}: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
