import { useEffect, useRef, useState, type JSX } from 'react';
import type { Connection } from '@otherbench/core/types/config.js';
import { isGenerationKind } from '@otherbench/core/domain/media.js';
import type { MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import { api, ApiError, type MediaModelsResult } from '../../state/api.js';

/** A profile's image and video choices, as the form holds them. An empty connection means none; an empty checkpoint, the workflow's own model file. */
export interface GenerationState {
  imageConnectionId: string;
  imageModel: string;
  imageCheckpoint: string;
  videoConnectionId: string;
  videoModel: string;
  videoCheckpoint: string;
  confirmPrompts: boolean;
}

interface ChoiceProps {
  media: 'image' | 'video';
  connections: Connection[];
  connectionId: string;
  model: string;
  checkpoint: string;
  /** A new connection or model always clears the checkpoint: the model file belongs to one workflow. */
  onChange: (connectionId: string, model: string, checkpoint: string) => void;
}

/** The model file a workflow runs when the profile picks none: the one saved with it, else the graph's own. */
function ownCheckpoint(wf: MediaWorkflow): string | null {
  if (wf.checkpoint) return wf.checkpoint;
  const b = wf.bindings.checkpoint;
  const value = b ? wf.graph[b.nodeId]?.inputs[b.input] : undefined;
  return typeof value === 'string' ? value : null;
}

/** One connection picker and, once one is chosen, the models (or, for ComfyUI, workflows and their model files) it offers. */
function Choice({ media, connections, connectionId, model, checkpoint, onChange }: ChoiceProps): JSX.Element {
  const title = media === 'image' ? 'Image' : 'Video';
  const conn = connections.find((c) => c.id === connectionId);
  const comfy = conn?.kind === 'comfyui';
  const thing = comfy ? 'workflow' : 'model';
  const [loaded, setLoaded] = useState<{ id: string; result: MediaModelsResult } | { id: string; error: string } | null>(null);
  // The workflows' bindings say which of them names a model file to choose.
  const [workflows, setWorkflows] = useState<MediaWorkflow[]>([]);
  useEffect(() => {
    if (!comfy) return;
    let cancelled = false;
    api.mediaWorkflows
      .list()
      .then((list) => {
        if (!cancelled) setWorkflows(list);
      })
      .catch((err: unknown) => console.error('[otherbench-web] failed to list workflows:', err));
    return () => {
      cancelled = true;
    };
  }, [comfy]);

  // The answer arrives later: it must act on what the form holds then, not when the question was asked.
  const latest = useRef({ model, onChange });
  useEffect(() => {
    latest.current = { model, onChange };
  });

  // A connection that was deleted (or is not one of these) has nothing to ask.
  const known = conn !== undefined;
  useEffect(() => {
    if (!connectionId || !known) return;
    let cancelled = false;
    api.connections
      .mediaModels(connectionId, media)
      .then((result) => {
        if (cancelled) return;
        setLoaded({ id: connectionId, result });
        // A connection just chosen has no model yet: start on its first. One already saved is left alone.
        if (!latest.current.model && result.models[0]) latest.current.onChange(connectionId, result.models[0].id, '');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error(`[otherbench-web] failed to list ${media} models for ${connectionId}:`, err);
        setLoaded({ id: connectionId, error: err instanceof ApiError ? err.message : `Could not list the ${thing}s.` });
      });
    return () => {
      cancelled = true;
    };
    // Only a different connection asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, media, known]);

  const current = loaded && loaded.id === connectionId ? loaded : null;
  const models = current && 'result' in current ? current.result.models : [];
  const error = current && 'error' in current ? current.error : null;
  const checkpoints = current && 'result' in current ? current.result.checkpoints : [];
  const workflow = comfy ? workflows.find((w) => w.id === model) : undefined;
  const own = workflow ? ownCheckpoint(workflow) : null;
  const select = 'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm';

  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
        {title} connection
        <select aria-label={`${title} connection`} value={connectionId} onChange={(e) => onChange(e.target.value, '', '')} className={select}>
          <option value="">None</option>
          {connectionId && !known && <option value={connectionId}>(missing connection)</option>}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {connectionId && !known && <p role="alert" className="self-end text-xs text-[var(--danger)]">This connection is missing. Choose another, or None.</p>}
      {connectionId && known && (
        <div>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            {title} {thing}
            <select aria-label={`${title} ${thing}`} value={model} onChange={(e) => onChange(connectionId, e.target.value, '')} disabled={models.length === 0 && !model} className={select}>
              {model && !models.some((m) => m.id === model) && <option value={model}>{model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="mt-1 text-xs text-[var(--danger)]">{error}</p>}
          {current && 'result' in current && current.result.checkpointsError && <p className="mt-1 text-xs text-[var(--text-muted)]">{current.result.checkpointsError}</p>}
        </div>
      )}
      {connectionId && known && workflow?.bindings.checkpoint && (
        <label className="col-span-2 flex flex-col gap-1 text-xs text-[var(--text-muted)]">
          {title} model file
          <select aria-label={`${title} model file`} value={checkpoint} onChange={(e) => onChange(connectionId, model, e.target.value)} className={select}>
            <option value="">{own ? `Workflow's own (${own})` : "Workflow's own"}</option>
            {checkpoint && !checkpoints.includes(checkpoint) && <option value={checkpoint}>{checkpoint}</option>}
            {checkpoints.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** What stops a save: a choice that names a connection the profile can no longer use, or null. */
export function generationProblem(connections: Connection[], value: GenerationState): string | null {
  const usable = (id: string, comfyOnly: boolean): boolean => connections.some((c) => c.id === id && isGenerationKind(c.kind) && (!comfyOnly || c.kind === 'comfyui'));
  if (value.imageConnectionId && !usable(value.imageConnectionId, false)) return 'The image connection is missing. Choose another, or set it to None.';
  if (value.videoConnectionId && !usable(value.videoConnectionId, true)) return 'The video connection is missing, or is not ComfyUI. Choose another, or set it to None.';
  return null;
}

/** The Generation part of a profile: which connection makes its images and its video, and whether it asks first. Not shown for Claude Code profiles. */
export function GenerationSection({ connections, value, onChange }: { connections: Connection[]; value: GenerationState; onChange: (next: GenerationState) => void }): JSX.Element {
  const generation = connections.filter((c) => isGenerationKind(c.kind));
  const video = generation.filter((c) => c.kind === 'comfyui');
  return (
    <div data-testid="generation-settings" className="space-y-2">
      <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Generation</span>
      {generation.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">Add a ComfyUI, Automatic1111 or OpenAI-compatible images connection in Settings &gt; Connections to let this profile make images.</p>
      ) : (
        <>
          <Choice
            media="image"
            connections={generation}
            connectionId={value.imageConnectionId}
            model={value.imageModel}
            checkpoint={value.imageCheckpoint}
            onChange={(c, m, k) => onChange({ ...value, imageConnectionId: c, imageModel: m, imageCheckpoint: k })}
          />
          <Choice
            media="video"
            connections={video}
            connectionId={value.videoConnectionId}
            model={value.videoModel}
            checkpoint={value.videoCheckpoint}
            onChange={(c, m, k) => onChange({ ...value, videoConnectionId: c, videoModel: m, videoCheckpoint: k })}
          />
          <p className="text-xs text-[var(--text-muted)]">Video needs ComfyUI.</p>
          <label className="flex items-center gap-1.5 text-xs text-[var(--text)]">
            <input type="checkbox" aria-label="Show me the prompt before generating" checked={value.confirmPrompts} onChange={(e) => onChange({ ...value, confirmPrompts: e.target.checked })} />
            Show me the prompt before generating
          </label>
        </>
      )}
    </div>
  );
}
