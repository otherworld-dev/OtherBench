import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { detectBindings, workflowGraphProblem, workflowImportProblem, workflowProblem, type MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import { BUILTIN_WORKFLOWS } from '@otherbench/tools/media/comfyui.js';
import type { Container } from '../container.js';
import { requireNonEmptyString } from '../validation.js';

const MAX_NAME = 200;

interface WorkflowBody {
  name?: unknown;
  media?: unknown;
  graph?: unknown;
  bindings?: unknown;
  checkpoint?: unknown;
}

const bad = (message: string): HTTPException => new HTTPException(400, { message });

function parseName(value: unknown): string {
  const name = requireNonEmptyString(value, 'name');
  if (name.length > MAX_NAME) throw bad(`"name" must be at most ${MAX_NAME} characters.`);
  return name;
}

function parseMedia(value: unknown): MediaWorkflow['media'] {
  if (value !== 'image' && value !== 'video') throw bad('"media" must be "image" or "video".');
  return value;
}

function parseCheckpoint(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw bad('"checkpoint" must be a string or null.');
  return value;
}

async function readBody(c: { req: { json(): Promise<unknown> } }): Promise<WorkflowBody> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object.');
  return body as WorkflowBody;
}

const isBuiltin = (id: string): boolean => BUILTIN_WORKFLOWS.some((w) => w.id === id);

/** Image and video generation: the workflows ComfyUI runs, built-in and imported. */
export function mediaRoutes(container: Container): Hono {
  const app = new Hono();
  const { mediaWorkflows } = container.store;

  const locked = (id: string): MediaWorkflow => {
    if (isBuiltin(id)) throw bad("Built-in workflows can't be changed.");
    const wf = mediaWorkflows.get(id);
    if (!wf) throw new HTTPException(404, { message: `Workflow "${id}" not found.` });
    return wf;
  };

  app.get('/workflows', (c) => c.json([...BUILTIN_WORKFLOWS, ...mediaWorkflows.list()]));

  // A first guess at the bindings for a pasted graph, so the form can start filled in.
  app.post('/workflows/detect', async (c) => {
    const body = await readBody(c);
    const shape = workflowGraphProblem(body.graph);
    if (shape) throw bad(shape);
    const graph = body.graph as MediaWorkflow['graph'];
    const bindings = detectBindings(graph);
    return c.json({ bindings, problem: workflowProblem({ graph, bindings }) });
  });

  app.post('/workflows', async (c) => {
    const body = await readBody(c);
    const name = parseName(body.name);
    const media = parseMedia(body.media);
    const checkpoint = parseCheckpoint(body.checkpoint);
    const problem = workflowImportProblem(body.graph, body.bindings);
    if (problem) throw bad(problem);
    const wf: MediaWorkflow = {
      id: randomUUID(),
      name,
      media,
      graph: body.graph as MediaWorkflow['graph'],
      bindings: body.bindings as MediaWorkflow['bindings'],
      ...(checkpoint === undefined ? {} : { checkpoint }),
      builtin: false,
    };
    return c.json(mediaWorkflows.create(wf), 201);
  });

  app.patch('/workflows/:id', async (c) => {
    const current = locked(c.req.param('id'));
    const body = await readBody(c);
    const next = {
      name: body.name === undefined ? current.name : parseName(body.name),
      media: body.media === undefined ? current.media : parseMedia(body.media),
      graph: body.graph === undefined ? current.graph : (body.graph as MediaWorkflow['graph']),
      bindings: body.bindings === undefined ? current.bindings : (body.bindings as MediaWorkflow['bindings']),
      checkpoint: body.checkpoint === undefined ? current.checkpoint : parseCheckpoint(body.checkpoint),
    };
    const problem = workflowImportProblem(next.graph, next.bindings);
    if (problem) throw bad(problem);
    return c.json(mediaWorkflows.update(current.id, next));
  });

  app.delete('/workflows/:id', (c) => {
    const wf = locked(c.req.param('id'));
    mediaWorkflows.delete(wf.id);
    return c.body(null, 204);
  });

  return app;
}
