import { useEffect, useMemo, useState, type JSX } from 'react';
import type { MediaWorkflow, WorkflowBinding, WorkflowRole } from '@otherbench/core/domain/media-workflows.js';
import { ApiError, api, type MediaModelsResult } from '../../state/api.js';

const ROLE_LABELS: Record<WorkflowRole, string> = {
  prompt: 'Prompt',
  negativePrompt: 'Negative prompt',
  seed: 'Seed',
  width: 'Width',
  height: 'Height',
  frames: 'Frame count',
  checkpoint: 'Model file (checkpoint)',
};
const ROLES = Object.keys(ROLE_LABELS) as WorkflowRole[];

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsText(file);
  });
}

type Graph = MediaWorkflow['graph'];
type Bindings = MediaWorkflow['bindings'];

/** Every input a binding could point at: the ones holding a plain value, not a wire to another node. */
function primitiveInputs(graph: Graph): { nodeId: string; input: string; label: string }[] {
  const out: { nodeId: string; input: string; label: string }[] = [];
  for (const [nodeId, node] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value)) continue;
      out.push({ nodeId, input, label: `${nodeId} · ${node.class_type} · ${input}` });
    }
  }
  return out;
}

interface Draft {
  graph: Graph;
  bindings: Bindings;
  name: string;
  media: 'image' | 'video';
  checkpoint: string;
  problem: string | null;
}

/**
 * The ComfyUI workflows OtherBench can run, inside a ComfyUI connection's form: the built-in ones, and the ones imported
 * from "Workflow → Export (API)". An import is checked by the server, which guesses which inputs hold the prompt, size and
 * so on; the person confirms or changes each before it is saved.
 */
export function WorkflowsSection({ connectionId }: { connectionId: string }): JSX.Element {
  const [workflows, setWorkflows] = useState<MediaWorkflow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checkpoints, setCheckpoints] = useState<MediaModelsResult | null>(null);

  async function reload(): Promise<void> {
    try {
      setWorkflows(await api.mediaWorkflows.list());
      setListError(null);
    } catch (err) {
      console.error('[otherbench-web] failed to list workflows:', err);
      setListError(errorMessage(err, 'Could not load the workflows.'));
    }
  }
  useEffect(() => {
    void reload();
  }, []);

  const media = draft?.media;
  useEffect(() => {
    if (!media) return;
    let cancelled = false;
    setCheckpoints(null);
    api.connections
      .mediaModels(connectionId, media)
      .then((r) => {
        if (!cancelled) setCheckpoints(r);
      })
      .catch((err: unknown) => {
        if (!cancelled) setCheckpoints({ models: [], checkpoints: [], checkpointsError: errorMessage(err, 'Could not list the model files.') });
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, media]);

  const inputs = useMemo(() => (draft ? primitiveInputs(draft.graph) : []), [draft?.graph]);

  async function handleFile(file: File): Promise<void> {
    setImportError(null);
    setDraft(null);
    let graph: unknown;
    try {
      graph = JSON.parse(await readText(file));
    } catch {
      setImportError("That file isn't valid JSON.");
      return;
    }
    try {
      const detected = await api.mediaWorkflows.detect(graph);
      setDraft({
        graph: graph as Graph,
        bindings: detected.bindings,
        name: file.name.replace(/\.json$/i, ''),
        media: 'image',
        checkpoint: '',
        problem: detected.problem,
      });
    } catch (err) {
      console.error('[otherbench-web] failed to read workflow:', err);
      setImportError(errorMessage(err, 'Could not read that workflow.'));
    }
  }

  function setBinding(role: WorkflowRole, index: string): void {
    setDraft((d) => {
      if (!d) return d;
      const next: Bindings = { ...d.bindings };
      const picked = index === '' ? undefined : inputs[Number(index)];
      if (picked) next[role] = { nodeId: picked.nodeId, input: picked.input };
      else delete next[role];
      return { ...d, bindings: next, problem: null };
    });
  }

  async function handleSave(): Promise<void> {
    if (!draft) return;
    if (draft.name.trim() === '') {
      setImportError('"Name" is required.');
      return;
    }
    setSaving(true);
    setImportError(null);
    try {
      await api.mediaWorkflows.create({
        name: draft.name.trim(),
        media: draft.media,
        graph: draft.graph,
        bindings: draft.bindings,
        ...(draft.bindings.checkpoint && draft.checkpoint !== '' ? { checkpoint: draft.checkpoint } : {}),
      });
      setDraft(null);
      await reload();
    } catch (err) {
      console.error('[otherbench-web] failed to save workflow:', err);
      setImportError(errorMessage(err, 'Save failed -- please try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(wf: MediaWorkflow): Promise<void> {
    if (!window.confirm(`Delete workflow "${wf.name}"? Profiles that use it will need another.`)) return;
    try {
      await api.mediaWorkflows.delete(wf.id);
      await reload();
    } catch (err) {
      console.error(`[otherbench-web] failed to delete workflow ${wf.id}:`, err);
      setListError(errorMessage(err, 'Delete failed -- please try again.'));
    }
  }

  const select = 'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm';
  const indexOf = (b: WorkflowBinding | undefined): string => (b ? String(inputs.findIndex((i) => i.nodeId === b.nodeId && i.input === b.input)) : '');

  return (
    <section data-testid="workflows-section" className="space-y-2 border-t border-[var(--border)] pt-3">
      <h3 className="text-xs font-medium text-[var(--text-muted)]">Workflows</h3>
      {listError && <p className="text-xs text-[var(--danger)]">{listError}</p>}
      <ul className="space-y-1">
        {(workflows ?? []).map((wf) => (
          <li key={wf.id} data-testid={`workflow-${wf.id}`} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{wf.name}</span>
            <span className="text-xs text-[var(--text-muted)]">{wf.media}</span>
            {wf.builtin || wf.id.startsWith('builtin:') ? (
              <span className="text-xs text-[var(--text-muted)]">built in</span>
            ) : (
              <button type="button" aria-label={`Delete workflow ${wf.name}`} onClick={() => void handleDelete(wf)} className="btn btn-danger px-2 py-0.5 text-xs">
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>

      <label className="block text-xs text-[var(--text-muted)]">
        Import a workflow (ComfyUI: Workflow → Export (API))
        <input
          type="file"
          accept=".json,application/json"
          aria-label="Import workflow file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleFile(file);
          }}
          className="mt-1 block text-sm"
        />
      </label>
      {importError && <p role="alert" className="text-xs text-[var(--danger)]">{importError}</p>}

      {draft && (
        <div data-testid="workflow-review" className="space-y-2 rounded border border-[var(--border)] bg-[var(--bg-sunken)] p-2">
          <p className="text-xs text-[var(--text-muted)]">Check which input of the workflow holds each of these. Leave one on none if the workflow has no such input.</p>
          {draft.problem && <p className="text-xs text-[var(--danger)]">{draft.problem}</p>}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              Workflow name
              <input aria-label="Workflow name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={select} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              Makes
              <select aria-label="Workflow makes" value={draft.media} onChange={(e) => setDraft({ ...draft, media: e.target.value as 'image' | 'video', checkpoint: '' })} className={select}>
                <option value="image">images</option>
                <option value="video">video</option>
              </select>
            </label>
          </div>
          {ROLES.map((role) => (
            <label key={role} className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              {ROLE_LABELS[role]}
              <select aria-label={`Input for ${ROLE_LABELS[role]}`} value={indexOf(draft.bindings[role])} onChange={(e) => setBinding(role, e.target.value)} className={select}>
                <option value="">none</option>
                {inputs.map((i, n) => (
                  <option key={`${i.nodeId}:${i.input}`} value={String(n)}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {draft.bindings.checkpoint && (
            <div>
              <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                Model file
                <select aria-label="Model file" value={draft.checkpoint} onChange={(e) => setDraft({ ...draft, checkpoint: e.target.value })} className={select}>
                  <option value="">Keep the workflow&apos;s own</option>
                  {(checkpoints?.checkpoints ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              {checkpoints?.checkpointsError && <p className="mt-1 text-xs text-[var(--text-muted)]">{checkpoints.checkpointsError}</p>}
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" disabled={saving} onClick={() => void handleSave()} className="btn btn-primary px-3 py-1">
              {saving ? 'Saving…' : 'Save workflow'}
            </button>
            <button type="button" disabled={saving} onClick={() => setDraft(null)} className="btn px-3 py-1">
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
