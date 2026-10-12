import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ArtifactVersion } from '@grunt/core/ports/store.js';
import { MarkdownBody } from '../components/MarkdownBody.js';
import { saveFile } from '../lib/saveFile.js';
import { ApiError, api, type ArtifactDetail, type LiveOutcome, type LiveStatus, type ViewOpened } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { serverUrl } from '../state/transport.js';
import { CodeView } from './CodeView.js';
import type { ViewItem } from './items.js';
import { LiveBar } from './LiveBar.js';
import { useLiveBridge } from './live-bridge.js';
import { useArtifactsStamp } from './stamp.js';

const BUTTON = 'btn px-2 py-0.5';
const SOURCE_LANGUAGE = { html: 'html', markdown: 'md', mermaid: 'plaintext', svg: 'xml' } as const;

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : "Couldn't load this artifact. Please try again.";
}

/**
 * An artifact in the viewer (spec 2026-10-07-artifacts): the branch's current
 * version unless one is pinned or picked, rendered by kind (pages and Mermaid
 * in the sandbox, SVG as an image, Markdown by React, code highlighted), with
 * Source, Edit, Copy, Download and Save to workspace. It reloads when the
 * reply the chat shows changes (a new reply, a branch switch, a part
 * streaming in), so an unpinned artifact follows the branch in the panel
 * and in a popped-out tab alike. A live page (spec 2026-10-12-live-artifacts)
 * gets the live bar, its calls relayed by the bridge, and is closed if it
 * navigates its own frame.
 */
export function ArtifactView({ chatId, item }: { chatId: string; item: Extract<ViewItem, { kind: 'artifact' }> }): JSX.Element {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [picked, setPicked] = useState<string | null>(item.versionId ?? null);
  const [version, setVersion] = useState<ArtifactVersion | null>(null);
  const [opened, setOpened] = useState<ViewOpened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ path: string; exists: string | null; done: string | null } | null>(null);
  const [reload, setReload] = useState(0);
  const workspaceHere = useGruntStore((s) => s.chats.find((c) => c.id === chatId)?.workspaceStatus?.status === 'ok');
  const stamp = useArtifactsStamp(chatId);

  // Each load starts clean, so a failure (a version not synced yet, say) clears on the next change.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.artifacts.get(chatId, item.artifactId).then(
      (d) => !cancelled && setDetail(d),
      (err: unknown) => !cancelled && setError(failure(err))
    );
    return () => {
      cancelled = true;
    };
  }, [chatId, item.artifactId, stamp, reload]);

  const versionId = picked ?? detail?.currentVersionId ?? detail?.versions.at(-1)?.id ?? null;
  // Each version is its own kind (a note made into a page), with its own file name.
  const shown = detail?.versions.find((v) => v.id === versionId);
  const kind = shown?.kind;

  // A live page (spec 2026-10-12-live-artifacts): an html version that declares data calls.
  const live = kind === 'html' && (shown?.live ?? 0) > 0;
  // What was learnt about the calls belongs to one version: it never stands in for another's while that loads.
  const [liveLoad, setLiveLoad] = useState<{ versionId: string; status: LiveStatus | null; error: string | null } | null>(null);
  const here = liveLoad !== null && liveLoad.versionId === versionId ? liveLoad : null;
  const liveStatus = here?.status ?? null;
  const liveError = here?.error ?? null;
  const [liveHidden, setLiveHidden] = useState(false);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, LiveOutcome>>(new Map());
  const [latest, setLatest] = useState<{ at: number; cached: boolean } | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [left, setLeft] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const loadsRef = useRef(0);
  const freshRef = useRef<Set<string> | null>(null);
  const versionRef = useRef(versionId);
  useLayoutEffect(() => {
    versionRef.current = versionId;
  });
  /** Each element counts its own documents: a new frame starts at none, and nothing else resets the count. */
  const attachFrame = useCallback((el: HTMLIFrameElement | null) => {
    frameRef.current = el;
    if (el) loadsRef.current = 0;
  }, []);

  useEffect(() => {
    if (!versionId || !kind) return;
    let cancelled = false;
    setError(null);
    setVersion(null);
    setOpened(null);
    api.artifacts.version(chatId, item.artifactId, versionId).then(
      (v) => !cancelled && setVersion(v),
      (err: unknown) => !cancelled && setError(failure(err))
    );
    if (kind === 'html' || kind === 'mermaid' || kind === 'svg') {
      api.view.openArtifact(chatId, versionId).then(
        (o) => !cancelled && setOpened(o),
        (err: unknown) => !cancelled && setError(failure(err))
      );
    }
    return () => {
      cancelled = true;
    };
  }, [chatId, item.artifactId, versionId, kind]);

  // Each live version's status: which of its calls are allowed here. A new version is a new document in a new frame.
  useEffect(() => {
    setLiveLoad(null);
    setLiveHidden(false);
    setOutcomes(new Map());
    setLatest(null);
    setLeft(false);
    setFrameKey((k) => k + 1);
    freshRef.current = null;
    if (!live || !versionId) return;
    let cancelled = false;
    api.artifacts.live.status(chatId, item.artifactId, versionId).then(
      (s) => !cancelled && setLiveLoad({ versionId, status: s, error: null }),
      (err: unknown) => !cancelled && setLiveLoad({ versionId, status: null, error: failure(err) })
    );
    return () => {
      cancelled = true;
    };
  }, [chatId, item.artifactId, versionId, live]);

  const allowed = useMemo(() => new Set((liveStatus?.calls ?? []).filter((c) => c.state === 'allowed').map((c) => c.callId)), [liveStatus]);

  useLiveBridge({
    // Whether this is a live page, not whether calls are allowed: an unapproved page still gets its not_approved reply.
    enabled: live && !left && (liveStatus !== null || liveError !== null),
    frameRef,
    loadsRef,
    freshRef,
    allowed,
    chatId,
    artifactId: item.artifactId,
    versionId,
    onOutcome: (callId, outcome) => {
      setOutcomes((o) => new Map(o).set(callId, outcome));
      if (outcome.ok) setLatest({ at: outcome.at, cached: outcome.cached });
    },
  });

  if (error)return <p role="alert" className="p-3 text-sm text-[var(--danger)]">{error}</p>;
  if (!detail || !shown || !kind) return <p className="p-3 text-sm text-[var(--text-faint)]">Opening…</p>;

  const onBranch = detail.versions.filter((v) => v.onBranch);
  const elsewhere = detail.versions.filter((v) => !v.onBranch);
  const name = opened?.name ?? shown.fileName;

  async function saveEdit(): Promise<void> {
    if (draft === null || !versionId) return;
    try {
      const made = await api.artifacts.edit(chatId, item.artifactId, { content: draft, fromVersionId: versionId });
      setDraft(null);
      // Your edit lands on the branch you're on, so a view that follows the
      // branch shows it by following; a pinned one moves to it.
      if (picked !== null) setPicked(made.id);
      setReload((r) => r + 1);
    } catch (err) {
      setError(failure(err));
    }
  }

  async function saveToWorkspace(replace: boolean): Promise<void> {
    if (!saving || !versionId) return;
    try {
      const done = await api.artifacts.save(chatId, item.artifactId, { versionId, path: saving.path, ...(replace ? { replace: true } : {}) });
      setSaving({ ...saving, exists: null, done: done.path });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setSaving({ ...saving, exists: err.message, done: null });
      else setError(failure(err));
    }
  }

  function onFrameLoad(): void {
    loadsRef.current += 1;
    // A second document in the same frame: the page navigated itself, maybe with data in the address.
    if (loadsRef.current > 1) setLeft(true);
  }

  /** A fresh link in a new frame: Reopen, Refresh (`fresh`: skip the server's cache once per call), and after Allow or Stop. */
  async function reloadFrame(fresh: boolean): Promise<void> {
    if (!versionId) return;
    const asked = versionId;
    try {
      const o = await api.view.openArtifact(chatId, asked);
      if (versionRef.current !== asked) return;
      freshRef.current = fresh ? new Set() : null;
      setOpened(o);
      setLeft(false);
      setFrameKey((k) => k + 1);
    } catch (err) {
      if (versionRef.current === asked) setError(failure(err));
    }
  }

  async function allowLive(): Promise<void> {
    if (!versionId) return;
    const asked = versionId;
    try {
      const s = await api.artifacts.live.allow(chatId, item.artifactId, asked);
      if (versionRef.current !== asked) return;
      setLiveLoad({ versionId: asked, status: s, error: null });
      setLiveHidden(false);
      await reloadFrame(false);
    } catch (err) {
      if (versionRef.current === asked) setLiveLoad({ versionId: asked, status: liveStatus, error: failure(err) });
    }
  }

  async function stopLive(): Promise<void> {
    if (!versionId) return;
    const asked = versionId;
    try {
      await api.artifacts.live.revoke(chatId, item.artifactId);
      const s = await api.artifacts.live.status(chatId, item.artifactId, asked);
      if (versionRef.current !== asked) return;
      setLiveLoad({ versionId: asked, status: s, error: null });
      setOutcomes(new Map());
      setLatest(null);
      await reloadFrame(false);
    } catch (err) {
      if (versionRef.current === asked) setLiveLoad({ versionId: asked, status: liveStatus, error: failure(err) });
    }
  }

  let body: JSX.Element;
  if (draft !== null) {
    body = (
      <div className="flex h-full flex-col gap-2 p-2">
        <textarea aria-label="Artifact source" value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] p-2 font-mono text-xs" />
        <div className="flex gap-2">
          <button type="button" onClick={() => void saveEdit()} className={BUTTON}>Save</button>
          <button type="button" onClick={() => setDraft(null)} className={BUTTON}>Cancel</button>
        </div>
      </div>
    );
  } else if (!version) {
    body = <p className="p-3 text-sm text-[var(--text-faint)]">Loading…</p>;
  } else if (kind === 'code' || source) {
    body = <CodeView text={version.content} language={kind === 'code' ? (shown.language ?? '') : SOURCE_LANGUAGE[kind]} />;
  } else if (kind === 'markdown') {
    body = <div className="p-4"><MarkdownBody text={version.content} /></div>;
  } else if (!opened?.url) {
    body = <p className="p-3 text-sm text-[var(--text-faint)]">Loading…</p>;
  } else if (kind === 'svg') {
    body = <div className="flex h-full items-center justify-center p-3"><img src={serverUrl(opened.url)} alt={version.title} className="max-h-full max-w-full object-contain" /></div>;
  } else if (live && liveStatus === null && liveError === null) {
    // Not until it's known which calls are allowed: the page asks as soon as it runs.
    body = <p className="p-3 text-sm text-[var(--text-faint)]">Loading…</p>;
  } else if (live && left) {
    body = (
      <div className="flex flex-col items-start gap-2 p-3 text-sm">
        <p>This page went to another address, so Grunt closed it.</p>
        <button type="button" onClick={() => void reloadFrame(false)} className={BUTTON}>Reopen</button>
      </div>
    );
  } else {
    body = (
      <iframe
        key={`${frameKey}:${opened.url}`}
        ref={live ? attachFrame : undefined}
        onLoad={live ? onFrameLoad : undefined}
        title={name}
        src={serverUrl(opened.url)}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="h-full w-full border-0 bg-white"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium">{version?.title ?? item.title}</span>
        <span className="text-[var(--text-faint)]">{kind}</span>
        <select aria-label="Version" value={versionId ?? ''} onChange={(e) => setPicked(e.target.value)} className="rounded border border-[var(--border)] bg-[var(--bg-raised)] px-1 py-0.5">
          {onBranch.map((v) => (
            <option key={v.id} value={v.id}>{`v${v.number}${v.madeBy === 'user' ? ' (yours)' : ''}`}</option>
          ))}
          {elsewhere.map((v) => (
            <option key={v.id} value={v.id}>{`v${v.number} (other branch)`}</option>
          ))}
        </select>
        {kind !== 'code' && draft === null && (
          <button type="button" aria-pressed={source} onClick={() => setSource((s) => !s)} className={BUTTON}>Source</button>
        )}
        {draft === null && version && (
          <button type="button" onClick={() => setDraft(version.content)} className={BUTTON}>Edit</button>
        )}
        {version && (
          <button type="button" onClick={() => void navigator.clipboard.writeText(version.content).catch(() => setError("Couldn't copy to the clipboard."))} className={BUTTON}>Copy</button>
        )}
        {version && (
          <button type="button" onClick={() => saveFile(new Blob([version.content], { type: 'text/plain' }), shown.fileName)} className={BUTTON}>Download</button>
        )}
        {workspaceHere && version && (
          <button type="button" onClick={() => setSaving({ path: shown.fileName, exists: null, done: null })} className={BUTTON}>Save to workspace</button>
        )}
      </div>
      {saving && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-1 text-xs">
          <input aria-label="Save as" value={saving.path} onChange={(e) => setSaving({ path: e.target.value, exists: null, done: null })} className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-0.5 font-mono" />
          {saving.exists ? (
            <>
              <span className="text-[var(--warn)]">{saving.exists}</span>
              <button type="button" onClick={() => void saveToWorkspace(true)} className={BUTTON}>Replace it</button>
            </>
          ) : (
            <button type="button" onClick={() => void saveToWorkspace(false)} className={BUTTON}>Save file</button>
          )}
          <button type="button" onClick={() => setSaving(null)} className={BUTTON}>Close</button>
          {saving.done && <span role="status">Saved to {saving.done}</span>}
        </div>
      )}
      {live && draft === null && !source && (
        <LiveBar
          status={liveStatus}
          error={liveError}
          hidden={liveHidden}
          latest={latest}
          outcomes={outcomes}
          onAllow={() => void allowLive()}
          onNotNow={() => setLiveHidden(true)}
          onRefresh={() => void reloadFrame(true)}
          onStop={() => void stopLive()}
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
