import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { MediaWorkflow, WorkflowBinding, WorkflowRole } from '@otherbench/core/domain/media-workflows.js';
import type { ComfyTemplate, RecentWorkflow } from '@otherbench/core/types/media-library.js';
import { ApiError, api, type MediaModelsResult } from '../../state/api.js';
import { openInBrowser } from '../../desktop/bridge.js';

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

/** The number held by a bound input, as text for a number field ('' when it isn't a number). */
function boundNumber(graph: Graph, b: WorkflowBinding | undefined): string {
  const v = b ? graph[b.nodeId]?.inputs[b.input] : undefined;
  return typeof v === 'number' ? String(v) : '';
}

/** A copy of the graph with a whole number written into a bound input. */
function withBoundNumber(graph: Graph, b: WorkflowBinding, value: number): Graph {
  const node = graph[b.nodeId];
  if (!node) return graph;
  return { ...graph, [b.nodeId]: { ...node, inputs: { ...node.inputs, [b.input]: value } } };
}

const wholeNumber = (text: string): number | null => (/^\d+$/.test(text.trim()) && Number(text) > 0 ? Number(text) : null);

/** Template names ComfyUI's front end accepts in `?template=` (it ignores any other character). */
const TEMPLATE_PARAM = /^[a-zA-Z0-9_.-]+$/;

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`;
}

/** The templates matching the search box (by title), grouped by ComfyUI's own category in the order it lists them. */
function templateGroups(templates: ComfyTemplate[], search: string): [string, ComfyTemplate[]][] {
  const q = search.trim().toLowerCase();
  const groups = new Map<string, ComfyTemplate[]>();
  for (const t of templates) {
    if (q !== '' && !t.title.toLowerCase().includes(q)) continue;
    groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
  }
  return [...groups];
}

type Tab = 'recent' | 'templates' | 'added';
const TABS: { id: Tab; label: string }[] = [
  { id: 'recent', label: 'Recently run' },
  { id: 'templates', label: 'Templates' },
  { id: 'added', label: 'Added to OtherBench' },
];

interface Draft {
  graph: Graph;
  bindings: Bindings;
  name: string;
  media: 'image' | 'video';
  checkpoint: string;
  /** Size and length as typed; saved into the bound inputs of the graph. */
  width: string;
  height: string;
  frames: string;
  problem: string | null;
  /** Set when an imported workflow is being edited rather than a new one reviewed: saving PATCHes it. */
  editingId?: string;
}

/**
 * The ComfyUI workflows OtherBench can run, inside a ComfyUI connection's form: the built-in ones, and the ones imported
 * from "Workflow → Export (API)". An import is checked by the server, which guesses which inputs hold the prompt, size and
 * so on; the person confirms or changes each before it is saved. An imported workflow's name, bindings and model file
 * can be changed later with Edit, in the same form.
 */
export function WorkflowsSection({ connectionId, baseUrl = '' }: { connectionId: string; baseUrl?: string }): JSX.Element {
  const [workflows, setWorkflows] = useState<MediaWorkflow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checkpoints, setCheckpoints] = useState<MediaModelsResult | null>(null);
  const [tab, setTab] = useState<Tab>('recent');
  const [recent, setRecent] = useState<RecentWorkflow[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ComfyTemplate[] | 'unsupported' | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function loadRecent(): Promise<void> {
    try {
      setRecent(await api.connections.comfyRecent(connectionId));
      setRecentError(null);
    } catch (err) {
      console.error('[otherbench-web] failed to list recent ComfyUI workflows:', err);
      setRecentError(errorMessage(err, 'Could not reach ComfyUI.'));
    }
  }
  useEffect(() => {
    void loadRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  useEffect(() => {
    if (tab !== 'templates' || templates !== null) return;
    let cancelled = false;
    api.connections
      .comfyTemplates(connectionId)
      .then((r) => {
        if (!cancelled) setTemplates('unsupported' in r ? 'unsupported' : r.templates);
      })
      .catch((err: unknown) => {
        console.error('[otherbench-web] failed to list ComfyUI templates:', err);
        if (!cancelled) setTemplatesError(errorMessage(err, 'Could not reach ComfyUI.'));
      });
    return () => {
      cancelled = true;
    };
  }, [tab, templates, connectionId]);

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
      setDraft(newDraft(graph as Graph, detected.bindings, file.name.replace(/\.json$/i, ''), 'image', detected.problem));
    } catch (err) {
      console.error('[otherbench-web] failed to read workflow:', err);
      setImportError(errorMessage(err, 'Could not read that workflow.'));
    }
  }

  function newDraft(graph: Graph, bindings: Bindings, name: string, media: 'image' | 'video', problem: string | null, extra: Partial<Draft> = {}): Draft {
    return {
      graph, bindings, name, media, checkpoint: '', problem,
      width: boundNumber(graph, bindings.width), height: boundNumber(graph, bindings.height), frames: boundNumber(graph, bindings.frames),
      ...extra,
    };
  }

  function startAdd(r: RecentWorkflow): void {
    setImportError(null);
    setDraft(newDraft(r.graph, r.bindings, r.name, r.media, r.problem));
  }

  function setBinding(role: WorkflowRole, index: string): void {
    setDraft((d) => {
      if (!d) return d;
      const next: Bindings = { ...d.bindings };
      const picked = index === '' ? undefined : inputs[Number(index)];
      if (picked) next[role] = { nodeId: picked.nodeId, input: picked.input };
      else delete next[role];
      const size = { width: boundNumber(d.graph, next.width), height: boundNumber(d.graph, next.height), frames: boundNumber(d.graph, next.frames) };
      return { ...d, bindings: next, problem: null, ...(role === 'width' || role === 'height' || role === 'frames' ? { [role]: size[role] } : {}) };
    });
  }

  function startEdit(wf: MediaWorkflow): void {
    setImportError(null);
    setDraft(newDraft(wf.graph, wf.bindings, wf.name, wf.media, null, { checkpoint: wf.checkpoint ?? '', editingId: wf.id }));
  }

  async function handleSave(): Promise<void> {
    if (!draft) return;
    if (draft.name.trim() === '') {
      setImportError('"Name" is required.');
      return;
    }
    // Size and length go into the bound inputs; the workflow keeps its own value for anything left alone.
    let graph = draft.graph;
    let graphChanged = false;
    const numbers: [WorkflowBinding | undefined, string, string][] = [
      [draft.bindings.width, draft.width, 'Size'],
      [draft.bindings.height, draft.height, 'Size'],
      [draft.media === 'video' ? draft.bindings.frames : undefined, draft.frames, 'Max length'],
    ];
    for (const [binding, text, what] of numbers) {
      if (!binding || text === boundNumber(graph, binding)) continue;
      const n = wholeNumber(text);
      if (n === null) {
        setImportError(`${what} must be a whole number above 0.`);
        return;
      }
      graph = withBoundNumber(graph, binding, n);
      graphChanged = true;
    }
    setSaving(true);
    setImportError(null);
    const checkpoint = draft.bindings.checkpoint && draft.checkpoint !== '' ? draft.checkpoint : null;
    try {
      if (draft.editingId) {
        // The graph stays as imported; null puts the model file back to the graph's own.
        await api.mediaWorkflows.update(draft.editingId, { name: draft.name.trim(), media: draft.media, ...(graphChanged ? { graph } : {}), bindings: draft.bindings, checkpoint });
      } else {
        await api.mediaWorkflows.create({
          name: draft.name.trim(),
          media: draft.media,
          graph,
          bindings: draft.bindings,
          ...(checkpoint !== null ? { checkpoint } : {}),
        });
      }
      setDraft(null);
      await Promise.all([reload(), loadRecent()]);
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

  function openTemplate(t: ComfyTemplate): void {
    const base = baseUrl.replace(/\/+$/, '');
    // ComfyUI's front end loads `?template=` only for plain names; any other opens its page and the hint says which to pick.
    const url = TEMPLATE_PARAM.test(t.name) ? `${base}/?template=${encodeURIComponent(t.name)}` : base;
    void openInBrowser(url).catch((err: unknown) => console.error('[otherbench-web] failed to open ComfyUI:', err));
  }

  const select = 'w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm';
  const indexOf = (b: WorkflowBinding | undefined): string => (b ? String(inputs.findIndex((i) => i.nodeId === b.nodeId && i.input === b.input)) : '');

  return (
    <section data-testid="workflows-section" className="space-y-2 border-t border-[var(--border)] pt-3">
      <h3 className="text-xs font-medium text-[var(--text-muted)]">Workflows</h3>
      <div role="tablist" aria-label="Workflows" className="flex gap-1 border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`workflows-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="workflows-panel"
            onClick={() => setTab(t.id)}
            className={`px-2 py-1 text-xs ${tab === t.id ? 'border-b-2 border-[var(--accent)] font-medium' : 'text-[var(--text-muted)]'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="workflows-panel" aria-labelledby={`workflows-tab-${tab}`} className="space-y-1">
        {tab === 'recent' && (
          <>
            {recentError && (
              <p className="text-xs text-[var(--danger)]">
                {recentError} Check the address and Test it above.
              </p>
            )}
            {recent !== null && recent.length === 0 && <p className="text-xs text-[var(--text-muted)]">Run a workflow in ComfyUI and it will show up here.</p>}
            <ul className="space-y-1">
              {(recent ?? []).map((r) => (
                <li key={r.promptId} data-testid={`recent-${r.promptId}`} className="space-y-0.5 rounded border border-[var(--border)] p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    <span className="text-xs text-[var(--text-muted)]">{r.media}</span>
                    {r.ranAt !== null && <span className="text-xs text-[var(--text-muted)]">{new Date(r.ranAt).toLocaleString()}</span>}
                    {r.added ? (
                      <span className="text-xs text-[var(--text-muted)]">Added</span>
                    ) : (
                      <button type="button" onClick={() => startAdd(r)} className="btn px-2 py-0.5 text-xs">
                        Add
                      </button>
                    )}
                  </div>
                  {r.models.length > 0 && (
                    <div className="truncate text-xs text-[var(--text-muted)]">
                      {r.models.map((m) => (
                        <span key={m} className="mr-2">
                          {m}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 text-xs text-[var(--text-muted)]">
                    {(
                      [
                        ['Prompt', !!r.bindings.prompt],
                        ['Seed', !!r.bindings.seed],
                        ['Size', !!(r.bindings.width && r.bindings.height)],
                        ...(r.media === 'video' ? [['Length', !!r.bindings.frames] as [string, boolean]] : []),
                        ['Negative', !!r.bindings.negativePrompt],
                        ['Model file', !!r.bindings.checkpoint],
                      ] as [string, boolean][]
                    ).map(([label, found]) => (
                      <span key={label} className={found ? '' : 'text-[var(--danger)]'}>
                        {found ? `${label} ✓` : `${label} missing`}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === 'templates' && (
          <>
            {templatesError && <p className="text-xs text-[var(--danger)]">{templatesError} Check the address and Test it above.</p>}
            {templates === 'unsupported' && <p className="text-xs text-[var(--text-muted)]">Templates need a newer ComfyUI.</p>}
            {Array.isArray(templates) && (
              <>
                <p className="text-xs text-[var(--text-muted)]">Run it once in ComfyUI, then add it from Recently run.</p>
                <input aria-label="Search templates" placeholder="Search templates" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm" />
                {templateGroups(templates, search).map(([category, rows]) => (
                  <div key={category}>
                    <h4 className="mt-2 text-xs font-medium">{category}</h4>
                    <ul className="space-y-1">
                      {rows.map((t) => (
                        <li key={t.name} className="space-y-0.5 rounded border border-[var(--border)] p-2 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate">{t.title}</span>
                            <span className="text-xs text-[var(--text-muted)]">{t.media}</span>
                            {t.sizeBytes !== null && <span className="text-xs text-[var(--text-muted)]">{formatGb(t.sizeBytes)} to download</span>}
                            <button type="button" aria-label={`Open ${t.title} in ComfyUI`} onClick={() => openTemplate(t)} className="btn px-2 py-0.5 text-xs">
                              Open in ComfyUI
                            </button>
                          </div>
                          {t.models.length > 0 && <div className="truncate text-xs text-[var(--text-muted)]">{t.models.join(' · ')}</div>}
                          {!TEMPLATE_PARAM.test(t.name) && <div className="text-xs text-[var(--text-muted)]">Open Templates in ComfyUI and choose {t.title}</div>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </>
        )}
        {tab === 'added' && (
          <>
            {listError && <p className="text-xs text-[var(--danger)]">{listError}</p>}
            <ul className="space-y-1">
              {(workflows ?? []).map((wf) => (
                <li key={wf.id} data-testid={`workflow-${wf.id}`} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{wf.name}</span>
                  <span className="text-xs text-[var(--text-muted)]">{wf.media}</span>
                  {wf.builtin || wf.id.startsWith('builtin:') ? (
                    <span className="text-xs text-[var(--text-muted)]">built in</span>
                  ) : (
                    <>
                      <button type="button" aria-label={`Edit workflow ${wf.name}`} onClick={() => startEdit(wf)} className="btn px-2 py-0.5 text-xs">
                        Edit
                      </button>
                      <button type="button" aria-label={`Delete workflow ${wf.name}`} onClick={() => void handleDelete(wf)} className="btn btn-danger px-2 py-0.5 text-xs">
                        Delete
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div>
        <button type="button" onClick={() => fileInput.current?.click()} className="btn px-2 py-1 text-xs">
          Import from file…
        </button>
        <span className="ml-2 text-xs text-[var(--text-muted)]">A workflow saved with Workflow → Export (API) in ComfyUI</span>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="Import workflow file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleFile(file);
          }}
          className="hidden"
        />
      </div>
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
          {draft.bindings.width && draft.bindings.height && (
            <div className="flex items-end gap-2 text-xs text-[var(--text-muted)]">
              <label className="flex flex-col gap-1">
                Size (width × height)
                <input aria-label="Size width" type="number" min={1} value={draft.width} onChange={(e) => setDraft({ ...draft, width: e.target.value })} className={select} />
              </label>
              <span className="pb-1">×</span>
              <input aria-label="Size height" type="number" min={1} value={draft.height} onChange={(e) => setDraft({ ...draft, height: e.target.value })} className={select} />
            </div>
          )}
          {draft.media === 'video' && draft.bindings.frames && (
            <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
              Max length (frames)
              <input aria-label="Max length (frames)" type="number" min={1} value={draft.frames} onChange={(e) => setDraft({ ...draft, frames: e.target.value })} className={select} />
            </label>
          )}
          {draft.bindings.checkpoint && (
            <div>
              <label className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                Model file
                <select aria-label="Model file" value={draft.checkpoint} onChange={(e) => setDraft({ ...draft, checkpoint: e.target.value })} className={select}>
                  <option value="">Keep the workflow&apos;s own</option>
                  {draft.checkpoint !== '' && !(checkpoints?.checkpoints ?? []).includes(draft.checkpoint) && <option value={draft.checkpoint}>{draft.checkpoint}</option>}
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
