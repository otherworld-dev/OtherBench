import { randomInt } from 'node:crypto';
import { confirmPromptsOf, unloadChatModelOf } from '@otherbench/core/domain/media.js';
import { shapeSizes, SHAPE_RATIOS, type Aspect, type WorkflowLimits } from '@otherbench/core/domain/media-workflows.js';
import { GENERATION_PROMPT_MAX_CHARS, type AskFn } from '@otherbench/core/domain/thread-tools.js';
import { MAX_TOOL_IMAGE_BYTES, MAX_TOOL_VIDEO_BYTES, sniffToolMediaMime } from '@otherbench/core/domain/tool-images.js';
import type { MediaApplies, MediaBackend, MediaOutput, MediaProgress, MediaRequest } from '@otherbench/core/ports/media.js';
import type { ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { MediaChoice, ToolPolicy } from '@otherbench/core/types/config.js';

// `generate_image` and `generate_video` (media-generation spec). Source
// `media`: every call goes through the provider's gate like any tool; the
// prompt ask comes after the broker allows the call, inside the tool.

type Media = 'image' | 'video';

export const IMAGE_TOOL = 'generate_image';
export const VIDEO_TOOL = 'generate_video';

/** A backend for one call, and how it takes a request. */
export interface ResolvedMedia {
  backend: MediaBackend;
  /** Names it, e.g. `"SDXL (ComfyUI)"`. */
  label: string;
  /** What it uses of a request; nothing else is shown in the ask or the result. */
  applies: MediaApplies;
  /** The negative prompt it runs with when given none (a ComfyUI workflow's own), shown in the ask to keep or edit. */
  defaultNegativePrompt: string | null;
  /**
   * True when a setting it doesn't apply still runs at a value of its own (a
   * ComfyUI workflow's), so the ask and result say "workflow default"; false
   * when it has no such setting at all (`openai_images` has no seed), so it is left out.
   */
  workflowDefaults: boolean;
}

/** Where the tools get a backend: the server resolves the connection and its secret (server/src/media.ts). */
export interface MediaHost {
  /**
   * The backend for a profile's choice. Throws a plain-English Error when it
   * can't be used (`'That generation connection no longer exists.'`, a
   * deleted workflow).
   */
  backendFor(connectionId: string, use: { media: Media; model: string }): Promise<ResolvedMedia>;
  /**
   * The size and length a workflow is built for, which the tool keeps to. Null
   * when the backend has no workflow limits (A1111, OpenAI-style): the tool
   * keeps its fixed image sizes then.
   */
  limitsFor(use: { connectionId: string; media: Media; model: string }): Promise<WorkflowLimits | null>;
  /**
   * Frees the GPU for the generation by unloading the profile's chat model,
   * when that applies. Never throws; does nothing when it doesn't apply.
   */
  freeGpu(use: { profileId: string; generationConnectionId: string }, signal: AbortSignal): Promise<void>;
}

/** What a generation call actually sent, by the result it returned: the audit records these, not the model's. */
const sentArgs = new WeakMap<object, Record<string, unknown>>();

/** The arguments to audit for a media tool's call: the model's, with the prompt and negative prompt that were sent. */
export function mediaAuditArgs(args: unknown, result: unknown): unknown {
  return (result !== null && typeof result === 'object' && sentArgs.get(result)) || args;
}

/** A setting the backend doesn't use: a ComfyUI workflow runs its own, others leave it out. */
const WORKFLOW_DEFAULT = 'workflow default';

const ASPECTS = Object.keys(SHAPE_RATIOS) as Aspect[];

/** The sizes of a backend with no workflow limits; a ComfyUI workflow takes its own (`shapeSizes`). */
const IMAGE_SIZES: Record<Aspect, [number, number]> = { square: [1024, 1024], portrait: [832, 1216], landscape: [1216, 832], wide: [1344, 768] };

const DEFAULT_SECONDS = 5;
/** At most one progress event per call this often; a stage change always goes out. */
const PROGRESS_MS = 500;
/** The longest backend error a result carries. */
const MAX_ERROR = 500;

const CANCELLED = "The user cancelled this generation. Don't try again unless they ask.";
const UNATTENDED = 'Nobody is here to check the prompt, so nothing was generated.';
const STOPPED_AT_ASK = 'The turn was stopped before the user answered, so nothing was generated.';
const STOPPED = 'The turn was stopped, so the generation was cancelled.';

interface MediaToolError {
  error: true;
  code: 'invalid_input' | 'generation_unavailable' | 'generation_cancelled' | 'approval_unavailable' | 'cancelled' | 'generation_failed';
  message: string;
}

const fail = (code: MediaToolError['code'], message: string): MediaToolError => ({ error: true, code, message });

interface Parsed {
  prompt: string;
  negativePrompt: string | null;
  aspect: Aspect;
  seed: number;
  seconds: number;
}

/** What a call can choose: a shape only where there is a size to shape, seconds only where the workflow holds a length. */
interface Shape {
  sizes: Record<Aspect, [number, number]> | null;
  /** The longest clip, whole seconds; null when there is no length to choose. */
  maxSeconds: number | null;
  fps: number;
}

function shapeOf(media: Media, limits: WorkflowLimits | null): Shape {
  const sizes = limits ? (limits.size ? shapeSizes(limits.size, media === 'video' ? 32 : 16) : null) : media === 'image' ? IMAGE_SIZES : null;
  const max = media === 'video' && limits?.maxFrames ? Math.floor((limits.maxFrames - 1) / limits.fps) : 0;
  return { sizes, maxSeconds: max >= 1 ? max : null, fps: limits?.fps ?? 24 };
}

function parseArgs(media: Media, shape: Shape, args: unknown): Parsed | { invalid: string } {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const prompt = a['prompt'];
  if (typeof prompt !== 'string' || prompt.trim() === '') return { invalid: '"prompt" must be a non-empty string.' };
  if (prompt.length > GENERATION_PROMPT_MAX_CHARS) return { invalid: `"prompt" can be at most ${GENERATION_PROMPT_MAX_CHARS} characters.` };
  const negative = a['negative_prompt'];
  if (negative !== undefined && negative !== null && typeof negative !== 'string') return { invalid: '"negative_prompt" must be a string.' };
  if (typeof negative === 'string' && negative.length > GENERATION_PROMPT_MAX_CHARS) return { invalid: `"negative_prompt" can be at most ${GENERATION_PROMPT_MAX_CHARS} characters.` };
  // With no size to shape, `aspect` isn't offered and a stray one is ignored.
  const aspect = shape.sizes ? (a['aspect'] ?? 'square') : 'square';
  if (!ASPECTS.includes(aspect as Aspect)) return { invalid: `"aspect" must be one of: ${ASPECTS.join(', ')}.` };
  const seed = a['seed'];
  if (seed !== undefined && seed !== null && !(typeof seed === 'number' && Number.isSafeInteger(seed) && seed >= 0)) return { invalid: '"seed" must be a whole number, 0 or more.' };
  const max = shape.maxSeconds;
  const seconds = max === null ? 0 : (a['seconds'] ?? Math.min(DEFAULT_SECONDS, max));
  if (max !== null && !(typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 1 && seconds <= max)) {
    return { invalid: `"seconds" must be a whole number from 1 to ${max}.` };
  }
  return {
    prompt,
    negativePrompt: typeof negative === 'string' && negative.trim() !== '' ? negative : null,
    aspect: aspect as Aspect,
    seed: typeof seed === 'number' ? seed : randomInt(2 ** 32),
    seconds: seconds as number,
  };
}

function parameters(shape: Shape): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    prompt: { type: 'string', description: 'The full generation prompt: subject, style, lighting, composition.' },
    negative_prompt: { type: 'string', description: 'What to keep out of it, where the backend takes one.' },
  };
  if (shape.sizes) properties['aspect'] = { type: 'string', enum: ASPECTS, default: 'square', description: 'The shape of the frame.' };
  properties['seed'] = { type: 'integer', minimum: 0, description: 'Repeat a seed to repeat a result; leave it out for a new one.' };
  if (shape.maxSeconds !== null) {
    properties['seconds'] = { type: 'integer', minimum: 1, maximum: shape.maxSeconds, default: Math.min(DEFAULT_SECONDS, shape.maxSeconds), description: 'How long the clip is.' };
  }
  return { type: 'object', properties, required: ['prompt'], additionalProperties: false };
}

function description(media: Media, confirm: boolean, shape: Shape): string {
  const what = media === 'image' ? 'an image' : 'a short video clip';
  const time = media === 'video' ? ' A clip takes minutes, so make one only when asked.' : '';
  const own =
    (shape.maxSeconds !== null ? ` Video from this workflow is up to ${shape.maxSeconds} s.` : '') + (shape.sizes === null ? ' This workflow uses its own size.' : '');
  const seen = confirm
    ? 'The user sees your prompt first and may edit or cancel it; the result tells you what was actually sent.'
    : 'It runs straight away, and the user sees the prompt you sent.';
  return (
    `Generates ${what} on the user's own generator. Write a full prompt from the user's words: the subject, ` +
    `the style or medium, the lighting, the composition and framing, in plain descriptive phrases. Add a negative ` +
    `prompt for what to keep out. ${seen} For a follow-up ("darker", "same again"), reuse the earlier prompt and seed.${time}${own}`
  );
}

/** One progress callback per call: at most one event per `PROGRESS_MS`, every stage change, nothing after the call ends. */
function throttled(send: (p: MediaProgress) => void): { onProgress: (p: MediaProgress) => void; end: () => void } {
  let stage: MediaProgress['stage'] | null = null;
  let at = Number.NEGATIVE_INFINITY;
  let ended = false;
  return {
    onProgress: (p) => {
      const now = Date.now();
      if (ended || (p.stage === stage && now - at < PROGRESS_MS)) return;
      stage = p.stage;
      at = now;
      try {
        send(p);
      } catch {
        // progress is cosmetic
      }
    },
    end: () => {
      ended = true;
    },
  };
}

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The first output of the right media within the cap, and a note for each one left out. */
function pick(media: Media, outputs: MediaOutput[]): { kept: { mime: string; bytes: Buffer } | null; notes: string[] } {
  const cap = media === 'image' ? MAX_TOOL_IMAGE_BYTES : MAX_TOOL_VIDEO_BYTES;
  const notes: string[] = [];
  let kept: { mime: string; bytes: Buffer } | null = null;
  let wrong = 0;
  let extra = 0;
  for (const { bytes } of outputs) {
    const mime = sniffToolMediaMime(bytes);
    if (mime === null || !mime.startsWith(`${media}/`)) {
      wrong += 1;
    } else if (bytes.length > cap) {
      notes.push(`The ${media} was ${megabytes(bytes.length)}, over the ${megabytes(cap)} limit, so it wasn't kept.`);
    } else if (kept) {
      extra += 1;
    } else {
      kept = { mime, bytes };
    }
  }
  const allowed = media === 'image' ? 'a PNG, JPEG, WebP or GIF image' : 'an MP4 or WebM video';
  if (wrong > 0) notes.push(wrong === 1 ? `1 file the generator returned isn't ${allowed}, so it was left out.` : `${wrong} files the generator returned aren't ${allowed}, so they were left out.`);
  if (extra > 0) notes.push(`The generator made ${extra} more ${media}${extra === 1 ? '' : 's'}; only the first is kept.`);
  return { kept, notes };
}

function mediaTool(media: Media, choice: MediaChoice, limits: WorkflowLimits | null, host: MediaHost, policy: ToolPolicy, askUser: AskFn, progress: (ctx: ToolContext, p: MediaProgress) => void): ToolSpec {
  const name = media === 'image' ? IMAGE_TOOL : VIDEO_TOOL;
  const confirm = confirmPromptsOf(policy);
  return {
    name,
    description: description(media, confirm, shapeOf(media, limits)),
    parameters: parameters(shapeOf(media, limits)),
    risk: 'execute',
    source: 'media',
    async execute(args: unknown, ctx: ToolContext): Promise<unknown> {
      // The workflow is read again now: it may have changed since the tools were listed, and nothing outside its limits is sent.
      let shape: Shape;
      try {
        shape = shapeOf(media, await host.limitsFor({ connectionId: choice.connectionId, media, model: choice.model }));
      } catch (err) {
        return fail('generation_unavailable', (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR));
      }
      const parsed = parseArgs(media, shape, args);
      if ('invalid' in parsed) return fail('invalid_input', parsed.invalid);
      // No size to shape: none is sent, so the workflow keeps its own and nothing is reported.
      const size = shape.sizes ? shape.sizes[parsed.aspect] : null;

      let resolved: ResolvedMedia;
      try {
        resolved = await host.backendFor(choice.connectionId, { media, model: choice.model });
      } catch (err) {
        return fail('generation_unavailable', (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR));
      }
      const { backend, label, applies } = resolved;

      // Only what the backend applies is shown, sent and reported. A backend that takes a
      // negative prompt always gets one (`''` for none), so a workflow's own is never sent unseen.
      const unapplied = (what: string): string | null => (resolved.workflowDefaults ? `${what}: ${WORKFLOW_DEFAULT}` : null);
      const seedText = applies.seed ? `seed ${parsed.seed}` : unapplied('seed');
      const sizeText = applies.size && size ? `${size[0]}×${size[1]}` : unapplied('size');
      const lengthText = media !== 'video' ? null : applies.frames && shape.maxSeconds !== null ? `${parsed.seconds} s` : unapplied('length');

      let prompt = parsed.prompt;
      let negativePrompt = applies.negativePrompt ? (parsed.negativePrompt ?? resolved.defaultNegativePrompt ?? '') : null;
      if (confirm) {
        // Nothing reaches the backend that wasn't shown, and nobody can be shown it in an unattended run.
        if (ctx.unattended === true) return fail('approval_unavailable', UNATTENDED);
        const settings = [sizeText, lengthText, seedText, label].filter((t) => t !== null).join(' · ');
        const outcome = await askUser(ctx, { kind: 'generation', toolName: name, media, prompt, negativePrompt, settings });
        if ('unattended' in outcome) return fail('approval_unavailable', UNATTENDED);
        if ('cancelled' in outcome) return fail('cancelled', STOPPED_AT_ASK);
        if (!('generate' in outcome.reply)) return fail('generation_cancelled', CANCELLED);
        prompt = outcome.reply.generate.prompt;
        // An emptied negative is sent as none; one the backend doesn't take is never sent, whatever the reply says.
        const edited = outcome.reply.generate.negativePrompt;
        negativePrompt = applies.negativePrompt ? edited ?? '' : null;
      }
      if (negativePrompt !== null && negativePrompt.trim() === '') negativePrompt = '';
      if (ctx.signal.aborted) return fail('cancelled', STOPPED);

      // The prompt is settled and the user said Generate (or wasn't asked): make room on the GPU first.
      // It is best effort, so a failure here never stops the generation.
      if (unloadChatModelOf(policy)) {
        try {
          await host.freeGpu({ profileId: ctx.profileId, generationConnectionId: choice.connectionId }, ctx.signal);
        } catch {
          // generation goes ahead
        }
        if (ctx.signal.aborted) return fail('cancelled', STOPPED);
      }

      const req: MediaRequest = { media, model: choice.model, prompt, negativePrompt, seed: parsed.seed };
      if (size) {
        req.width = size[0];
        req.height = size[1];
      }
      if (media === 'video' && shape.maxSeconds !== null) req.frames = parsed.seconds * shape.fps + 1;
      if (choice.checkpoint !== undefined) req.checkpoint = choice.checkpoint;
      const sent: Record<string, unknown> = { ...(args as Record<string, unknown>), prompt };
      if (negativePrompt === null) delete sent['negative_prompt'];
      else sent['negative_prompt'] = negativePrompt;
      const remember = <T extends object>(result: T): T => {
        sentArgs.set(result, sent);
        return result;
      };

      const callId = ctx.toolCallId;
      const relay = throttled((p) => {
        if (callId) progress(ctx, p);
      });
      let outputs: MediaOutput[];
      try {
        outputs = await backend.generate(req, relay.onProgress, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) return remember(fail('cancelled', STOPPED));
        return remember(fail('generation_failed', (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR) || 'The generation failed.'));
      } finally {
        relay.end();
      }
      if (ctx.signal.aborted) return remember(fail('cancelled', STOPPED));

      const { kept, notes } = pick(media, outputs);
      if (!kept) return remember(fail('generation_failed', notes.length > 0 ? notes.join(' ') : 'The generator finished but returned nothing.'));
      const negative = negativePrompt === null ? null : `negative: ${negativePrompt === '' ? 'none' : JSON.stringify(negativePrompt)}`;
      const made = [`Generated ${media === 'image' ? 'an image' : 'a video'} with prompt: ${JSON.stringify(prompt)}`, negative, seedText, sizeText, lengthText, label];
      const text = `${made.filter((t) => t !== null).join('; ')}.` + (notes.length > 0 ? ` ${notes.join(' ')}` : '');
      return remember([
        { type: 'text', text },
        { type: media, data: kept.bytes.toString('base64'), mimeType: kept.mime },
      ]);
    },
  };
}

/**
 * `generate_image` when the profile has an image choice, `generate_video` when it has a video one.
 * Each is built from its workflow's own limits, read now: the host has them for the connection and model chosen.
 */
export async function mediaTools(host: MediaHost, policy: ToolPolicy, askUser: AskFn, progress: (ctx: ToolContext, p: MediaProgress) => void): Promise<ToolSpec[]> {
  const tools: ToolSpec[] = [];
  const limitsOf = async (media: Media, choice: MediaChoice): Promise<WorkflowLimits | null> => {
    // A workflow that can't be read now is reported by the call itself, so the tool is still offered.
    try {
      return await host.limitsFor({ connectionId: choice.connectionId, media, model: choice.model });
    } catch {
      return null;
    }
  };
  if (policy.media?.image) tools.push(mediaTool('image', policy.media.image, await limitsOf('image', policy.media.image), host, policy, askUser, progress));
  if (policy.media?.video) tools.push(mediaTool('video', policy.media.video, await limitsOf('video', policy.media.video), host, policy, askUser, progress));
  return tools;
}
