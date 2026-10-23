import { useEffect, useRef, useState, type JSX } from 'react';
import type { Connection } from '@otherbench/core/types/config.js';
import { isGenerationKind } from '@otherbench/core/domain/media.js';
import { api, ApiError, type MediaModelsResult } from '../../state/api.js';

/** A profile's image and video choices, as the form holds them. An empty connection means none. */
export interface GenerationState {
  imageConnectionId: string;
  imageModel: string;
  videoConnectionId: string;
  videoModel: string;
  confirmPrompts: boolean;
}

interface ChoiceProps {
  media: 'image' | 'video';
  connections: Connection[];
  connectionId: string;
  model: string;
  onChange: (connectionId: string, model: string) => void;
}

/** One connection picker and, once one is chosen, the models (or, for ComfyUI, workflows) it offers. */
function Choice({ media, connections, connectionId, model, onChange }: ChoiceProps): JSX.Element {
  const title = media === 'image' ? 'Image' : 'Video';
  const conn = connections.find((c) => c.id === connectionId);
  const thing = conn?.kind === 'comfyui' ? 'workflow' : 'model';
  const [loaded, setLoaded] = useState<{ id: string; result: MediaModelsResult } | { id: string; error: string } | null>(null);

  // The answer arrives later: it must act on what the form holds then, not when the question was asked.
  const latest = useRef({ model, onChange });
  useEffect(() => {
    latest.current = { model, onChange };
  });

  useEffect(() => {
    if (!connectionId) return;
    let cancelled = false;
    api.connections
      .mediaModels(connectionId, media)
      .then((result) => {
        if (cancelled) return;
        setLoaded({ id: connectionId, result });
        // A connection just chosen has no model yet: start on its first. One already saved is left alone.
        if (!latest.current.model && result.models[0]) latest.current.onChange(connectionId, result.models[0].id);
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
  }, [connectionId, media]);

  const current = loaded && loaded.id === connectionId ? loaded : null;
  const models = current && 'result' in current ? current.result.models : [];
  const error = current && 'error' in current ? current.error : null;
  const select = 'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm';

  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
        {title} connection
        <select aria-label={`${title} connection`} value={connectionId} onChange={(e) => onChange(e.target.value, '')} className={select}>
          <option value="">None</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {connectionId && (
        <div>
          <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
            {title} {thing}
            <select aria-label={`${title} ${thing}`} value={model} onChange={(e) => onChange(connectionId, e.target.value)} disabled={models.length === 0 && !model} className={select}>
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
    </div>
  );
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
          <Choice media="image" connections={generation} connectionId={value.imageConnectionId} model={value.imageModel} onChange={(c, m) => onChange({ ...value, imageConnectionId: c, imageModel: m })} />
          <Choice media="video" connections={video} connectionId={value.videoConnectionId} model={value.videoModel} onChange={(c, m) => onChange({ ...value, videoConnectionId: c, videoModel: m })} />
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
