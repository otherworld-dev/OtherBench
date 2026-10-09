import { useEffect, useState, type JSX } from 'react';
import type { ImportPhase, ImportPreview, ImportReport, ImportStatus, MemoryOutcome } from '@grunt/core/types/claude-import.js';
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
  chats: 'Importing chats',
  artifacts: 'Importing published artifacts',
  projects: 'Importing projects',
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

/**
 * Settings > Import (spec 2026-10-09-claude-import-design §6): choose the
 * folder a claude.ai export was downloaded to, check what importing it would
 * do, then run it and watch it go. Chats appear in the sidebar as they land,
 * through the app-wide events.
 */
export function ImportPanel(): JSX.Element {
  const profiles = useGruntStore((s) => s.profiles);
  const connections = useGruntStore((s) => s.connections);
  const [folder, setFolder] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [memory, setMemory] = useState(true);
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

  async function check(): Promise<void> {
    setChecking(true);
    setError(null);
    setPreview(null);
    try {
      const next = await api.claudeImport.preview(folder.trim(), profileId || null);
      setPreview(next);
      setMemory(next.memoryModel !== null && hasMemory(next));
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
      setStatus(await api.claudeImport.start({ folder: from.folder, profileId, memory }));
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
          Brings your claude.ai chats, projects, published artifacts and memory into Grunt. On claude.ai, open Settings &rarr; Privacy and choose Export data. When
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
  starting: boolean;
  onImport: () => void;
}

function PreviewView({ preview, profiles, profileId, onProfile, memory, onMemory, starting, onImport }: PreviewProps): JSX.Element {
  const { chats, memory: notes } = preview;
  const fresh = chats.total - chats.existing;
  return (
    <div data-testid="import-preview" className="space-y-4 rounded border border-[var(--border)] p-3">
      <ul className="list-disc space-y-1 pl-5">
        <li>
          {count(chats.total, 'chat')} ({count(chats.messages, 'message')}
          {chats.branched > 0 ? `, ${chats.branched.toLocaleString('en-US')} with more than one branch` : ''})
          {chats.existing > 0 ? `; ${chats.existing.toLocaleString('en-US')} already imported, which will be skipped` : ''}
        </li>
        {preview.emptyChats > 0 && <li>{count(preview.emptyChats, 'empty conversation')} left out</li>}
        {preview.artifacts.length > 0 && <li>{count(preview.artifacts.length, 'published artifact')}, each in a chat of its own</li>}
        {preview.projects.map((p) => (
          <li key={p.name}>
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
                  notes.about ? (notes.aboutTaken ? 'About you already has text, so it stays as it is.' : "About you is written from claude.ai's notes.") : null,
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

function outcomeText(outcome: MemoryOutcome): string {
  return outcome.status === 'saved' ? 'saved' : `${outcome.status}: ${outcome.reason}`;
}

function ReportView({ report }: { report: ImportReport }): JSX.Element {
  const failures = [...report.chats.failed, ...report.artifacts.failed, ...report.projects.failed];
  const { projects, memory } = report;
  return (
    <div className="space-y-2">
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Imported {count(report.chats.imported, 'chat')} ({count(report.chats.messages, 'message')})
          {report.chats.existing > 0 ? `; ${report.chats.existing.toLocaleString('en-US')} were already here` : ''}
        </li>
        {report.artifacts.imported + report.artifacts.existing > 0 && <li>Imported {count(report.artifacts.imported, 'published artifact')}</li>}
        {projects.created.length > 0 && <li>New projects: {projects.created.join(', ')}</li>}
        {projects.merged.length > 0 && <li>Merged into your projects: {projects.merged.join(', ')}</li>}
        {report.docs.folders.map((f) => (
          <li key={f.path}>
            {f.project}&rsquo;s docs are in <span className="font-mono">{f.path}</span>
            {f.attached ? ', attached to the project read-only' : ", not attached: the project has no room for another folder"}
          </li>
        ))}
        {memory && (
          <li>
            Memory{memory.model ? ` (with ${memory.model})` : ''}: About you {outcomeText(memory.about)}; learned note {outcomeText(memory.note)}
            {memory.projects.map((p) => `; ${p.name} ${outcomeText(p.outcome)}`).join('')}
          </li>
        )}
        {report.memoryFiles && (
          <li>
            claude.ai&rsquo;s memory files are in <span className="font-mono">{report.memoryFiles}</span>
          </li>
        )}
        {report.filesNotIncluded > 0 && <li>{count(report.filesNotIncluded, 'image or file', 'images and files')} weren&rsquo;t in the export</li>}
      </ul>
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
