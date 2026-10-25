import { describe, it, expect } from 'vitest';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import { MAX_TOOL_IMAGE_BYTES } from '@otherbench/core/domain/tool-images.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { shapeSizes, workflowApplies, workflowLimits, type WorkflowLimits } from '@otherbench/core/domain/media-workflows.js';
import type { MediaApplies, MediaBackend, MediaProgress, MediaRequest } from '@otherbench/core/ports/media.js';
import type { AskInput, AskOutcome, ToolApprovalEvent, ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { ToolPolicy } from '@otherbench/core/types/config.js';
import { BUILTIN_WORKFLOWS } from '../../src/media/comfyui.js';
import { mediaTools, type MediaHost } from '../../src/media/tool.js';
import { OtherBenchToolProvider } from '../../src/provider.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(20, 2)]);

function policy(overrides: Partial<ToolPolicy> = {}): ToolPolicy {
  return {
    fs: 'none',
    shell: false,
    mcpServerIds: [],
    approvalMode: 'ask_on_mutate',
    media: { image: { connectionId: 'gen', model: 'builtin:sdxl-txt2img' }, video: { connectionId: 'gen', model: 'builtin:wan22-5b-t2v' } },
    ...overrides,
  };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { chatId: 'chat-1', messageId: 'msg-1', profileId: 'p1', workspaceRoot: null, signal: new AbortController().signal, toolCallId: 'call-1', ...overrides };
}

class FakeBackend implements MediaBackend {
  requests: MediaRequest[] = [];
  signals: AbortSignal[] = [];
  outputs: Buffer[] = [PNG];
  /** Called with the progress callback while generating. */
  during: (onProgress: (p: MediaProgress) => void, signal: AbortSignal) => Promise<void> = async () => {};
  async generate(req: MediaRequest, onProgress: (p: MediaProgress) => void, signal: AbortSignal) {
    this.requests.push(req);
    this.signals.push(signal);
    await this.during(onProgress, signal);
    return this.outputs.map((bytes) => ({ bytes }));
  }
  async test() {}
  async listModels() {
    return [];
  }
}

/** What A1111 applies: everything, with no negative prompt of its own. */
const ALL: MediaApplies = { negativePrompt: true, seed: true, size: true, frames: true };
const OPENAI: MediaApplies = { negativePrompt: false, seed: false, size: true, frames: false };

/** How a backend takes a request, as `MediaHost.backendFor` reports it. */
type Takes = { label: string; applies: MediaApplies; defaultNegativePrompt: string | null; workflowDefaults: boolean };

const WAN = BUILTIN_WORKFLOWS.find((w) => w.id === 'builtin:wan22-5b-t2v')!;
const SDXL_WF = BUILTIN_WORKFLOWS.find((w) => w.id === 'builtin:sdxl-txt2img')!;
const SDXL_LIMITS = workflowLimits(SDXL_WF);
const WAN_LIMITS = workflowLimits(WAN);

/** The extra MediaHost methods, for a host that only cares about backendFor. */
const noLimits = {
  limitsFor: async () => null,
  freeGpu: async () => {},
};

async function setup(opts: { reply?: (input: AskInput) => AskOutcome; host?: MediaHost; policy?: ToolPolicy; takes?: Takes; limits?: Partial<Record<'image' | 'video', WorkflowLimits | null>>; freeGpu?: MediaHost['freeGpu'] } = {}) {
  const backend = new FakeBackend();
  const asks: AskInput[] = [];
  const progress: { ctx: ToolContext; p: MediaProgress }[] = [];
  const used: { connectionId: string; media: string; model: string }[] = [];
  const takes = opts.takes ?? { label: 'SDXL (ComfyUI)', applies: ALL, defaultNegativePrompt: null, workflowDefaults: true };
  const freed: { profileId: string; generationConnectionId: string; backendRequests: number }[] = [];
  const limits = { image: SDXL_LIMITS, video: WAN_LIMITS, ...opts.limits };
  const host: MediaHost = opts.host ?? {
    async backendFor(connectionId, use) {
      used.push({ connectionId, ...use });
      return { backend, ...takes };
    },
    async limitsFor(use) {
      return limits[use.media];
    },
    async freeGpu(use, signal) {
      freed.push({ ...use, backendRequests: backend.requests.length });
      await opts.freeGpu?.(use, signal);
    },
  };
  const reply = opts.reply ?? ((input: AskInput) => ({ reply: { generate: { prompt: (input as { prompt: string }).prompt, negativePrompt: null } } }));
  const tools = await mediaTools(
    host,
    opts.policy ?? policy(),
    async (_ctx, input) => {
      asks.push(input);
      return reply(input);
    },
    (c, p) => progress.push({ ctx: c, p })
  );
  const tool = (name: string): ToolSpec => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no ${name}`);
    return t;
  };
  return { backend, asks, progress, used, freed, tools, tool };
}

type Item = { type: string; text?: string; data?: string; mimeType?: string };

describe('generate_image / generate_video', () => {
  it('offers each tool only when the profile has that choice, as source media with risk execute', async () => {
    expect((await setup()).tools.map((t) => [t.name, t.source, t.risk])).toEqual([
      ['generate_image', 'media', 'execute'],
      ['generate_video', 'media', 'execute'],
    ]);
    expect((await setup({ policy: policy({ media: { image: { connectionId: 'gen', model: 'm' } } }) })).tools.map((t) => t.name)).toEqual(['generate_image']);
    expect((await setup({ policy: policy({ media: undefined }) })).tools).toEqual([]);
  });

  it('tells the model to write a full prompt and that the user sees it first', async () => {
    const { tool } = await setup();
    expect(tool('generate_image').description).toMatch(/subject.*style.*lighting.*composition/is);
    expect(tool('generate_image').description).toMatch(/user sees/i);
  });

  it('asks with the model prompt, then sends and reports the edited one', async () => {
    const { backend, asks, tool } = await setup({ reply: () => ({ reply: { generate: { prompt: 'edited', negativePrompt: null } } }) });
    const result = (await tool('generate_image').execute({ prompt: 'a red cube', negative_prompt: 'blurry', seed: 7 }, ctx())) as Item[];
    expect(asks).toEqual([
      { kind: 'generation', toolName: 'generate_image', media: 'image', prompt: 'a red cube', negativePrompt: 'blurry', settings: '1024×1024 · seed 7 · SDXL (ComfyUI)' },
    ]);
    expect(backend.requests[0]).toMatchObject({ media: 'image', model: 'builtin:sdxl-txt2img', prompt: 'edited', negativePrompt: '', width: 1024, height: 1024, seed: 7 });
    expect(result[0]!.type).toBe('text');
    expect(result[0]!.text).toBe('Generated an image with prompt: "edited"; negative: none; seed 7; 1024×1024; SDXL (ComfyUI).');
    expect(result[1]).toEqual({ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
  });

  it('a decline returns generation_cancelled and never calls the backend', async () => {
    const { backend, tool } = await setup({ reply: () => ({ reply: { declined: true } }) });
    const result = await tool('generate_image').execute({ prompt: 'a red cube' }, ctx());
    expect(result).toEqual({ error: true, code: 'generation_cancelled', message: "The user cancelled this generation. Don't try again unless they ask." });
    expect(backend.requests).toEqual([]);
  });

  it('unattended with confirm prompts on returns approval_unavailable and never calls the backend', async () => {
    const { backend, tool } = await setup({ reply: () => ({ unattended: true }) });
    const result = await tool('generate_image').execute({ prompt: 'a red cube' }, ctx({ unattended: true }));
    expect(result).toEqual({ error: true, code: 'approval_unavailable', message: 'Nobody is here to check the prompt, so nothing was generated.' });
    expect(backend.requests).toEqual([]);
  });

  it('a stopped turn at the ask ends as stopped, not as a decline', async () => {
    const { backend, tool } = await setup({ reply: () => ({ cancelled: true }) });
    const result = (await tool('generate_image').execute({ prompt: 'a red cube' }, ctx())) as { code: string };
    expect(result.code).toBe('cancelled');
    expect(backend.requests).toEqual([]);
  });

  it('with confirm prompts off, makes no ask and sends the model prompt, unattended included', async () => {
    const { backend, asks, tool } = await setup({ policy: policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } }) });
    await tool('generate_image').execute({ prompt: 'a red cube' }, ctx({ unattended: true }));
    expect(asks).toEqual([]);
    expect(backend.requests[0]!.prompt).toBe('a red cube');
  });

  it("sizes by aspect from the workflow's own size", async () => {
    const { backend, tool } = await setup();
    await tool('generate_image').execute({ prompt: 'p', aspect: 'wide' }, ctx());
    await tool('generate_image').execute({ prompt: 'p' }, ctx());
    await tool('generate_video').execute({ prompt: 'p', aspect: 'portrait' }, ctx());
    await tool('generate_video').execute({ prompt: 'p', aspect: 'landscape' }, ctx());
    expect(backend.requests.map((r) => [r.width, r.height])).toEqual([
      [1360, 768],
      [1024, 1024],
      [704, 1280],
      shapeSizes({ width: 1280, height: 704 }, 32).landscape,
    ]);
  });

  it('a backend with no workflow limits keeps the fixed image sizes', async () => {
    const { backend, tool } = await setup({ limits: { image: null } });
    expect((tool('generate_image').parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('aspect');
    await tool('generate_image').execute({ prompt: 'p', aspect: 'portrait' }, ctx());
    await tool('generate_image').execute({ prompt: 'p', aspect: 'wide' }, ctx());
    expect(backend.requests.map((r) => [r.width, r.height])).toEqual([
      [832, 1216],
      [1344, 768],
    ]);
  });

  it("offers seconds up to the workflow's length, and refuses more", async () => {
    const { backend, asks, tool } = await setup();
    const props = (tool('generate_video').parameters as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props['seconds']).toMatchObject({ maximum: 5, default: 5, minimum: 1 });
    expect(props['aspect']).toBeDefined();
    expect(tool('generate_video').description).toContain('up to 5 s');
    expect(await tool('generate_video').execute({ prompt: 'p', seconds: 6 }, ctx())).toEqual({
      error: true,
      code: 'invalid_input',
      message: '"seconds" must be a whole number from 1 to 5.',
    });
    expect(asks).toEqual([]);
    expect(backend.requests).toEqual([]);
  });

  it('a workflow with no size offers no aspect and says its size is the workflow default', async () => {
    const { backend, asks, tool } = await setup({ limits: { image: { size: null, maxFrames: null, fps: 24 } } });
    const t = tool('generate_image');
    expect((t.parameters as { properties: Record<string, unknown> }).properties).not.toHaveProperty('aspect');
    expect(t.description).toContain('This workflow uses its own size.');
    const result = (await t.execute({ prompt: 'a cat', seed: 1 }, ctx())) as Item[];
    expect(backend.requests[0]).toMatchObject({ width: 0, height: 0 });
    expect((asks[0] as { settings: string }).settings).toBe('size: workflow default · seed 1 · SDXL (ComfyUI)');
    expect(result[0]!.text).toContain('size: workflow default');
    expect(result[0]!.text).not.toContain('0×0');
  });

  it('a workflow with no length offers no seconds and sends no frames', async () => {
    const { backend, tool } = await setup({ limits: { video: { size: { width: 832, height: 480 }, maxFrames: null, fps: 16 } } });
    expect((tool('generate_video').parameters as { properties: Record<string, unknown> }).properties).not.toHaveProperty('seconds');
    backend.outputs = [MP4];
    await tool('generate_video').execute({ prompt: 'p', seconds: 3 }, ctx());
    expect(backend.requests[0]!.frames).toBeUndefined();
  });

  it("uses the workflow's own frame rate for frames and the longest clip", async () => {
    const { backend, tool } = await setup({ limits: { video: { size: { width: 832, height: 480 }, maxFrames: 81, fps: 16 } } });
    expect((tool('generate_video').parameters as { properties: Record<string, Record<string, unknown>> }).properties['seconds']).toMatchObject({ maximum: 5, default: 5 });
    backend.outputs = [MP4];
    await tool('generate_video').execute({ prompt: 'p', seconds: 2 }, ctx());
    expect(backend.requests[0]!.frames).toBe(33);
  });

  it('seconds: 3 sends 73 frames; video defaults to 5 seconds', async () => {
    const { backend, tool } = await setup();
    backend.outputs = [MP4];
    const result = (await tool('generate_video').execute({ prompt: 'a wave', seconds: 3, seed: 1 }, ctx())) as Item[];
    await tool('generate_video').execute({ prompt: 'a wave' }, ctx());
    expect(backend.requests.map((r) => [r.media, r.frames])).toEqual([
      ['video', 73],
      ['video', 121],
    ]);
    expect(result[1]).toEqual({ type: 'video', data: MP4.toString('base64'), mimeType: 'video/mp4' });
    expect(result[0]!.text).toContain('Generated a video with prompt: "a wave"');
  });

  it('picks a seed when the model gives none, and the ask and result name it', async () => {
    const { backend, asks, tool } = await setup();
    const result = (await tool('generate_image').execute({ prompt: 'p' }, ctx())) as Item[];
    const seed = backend.requests[0]!.seed;
    expect(Number.isSafeInteger(seed) && seed >= 0).toBe(true);
    expect((asks[0] as { settings: string }).settings).toContain(`seed ${seed}`);
    expect(result[0]!.text).toContain(`seed ${seed};`);
  });

  it('refuses bad arguments before anything else', async () => {
    const { backend, asks, tool } = await setup();
    for (const args of [{}, { prompt: '  ' }, { prompt: 'p', aspect: 'tall' }, { prompt: 'p', seed: -1 }, { prompt: 'p', seed: 1.5 }, { prompt: 'x'.repeat(4001) }]) {
      expect(await tool('generate_image').execute(args, ctx())).toMatchObject({ error: true, code: 'invalid_input' });
    }
    for (const seconds of [0, 6, 2.5]) {
      expect(await tool('generate_video').execute({ prompt: 'p', seconds }, ctx())).toMatchObject({ error: true, code: 'invalid_input' });
    }
    expect(asks).toEqual([]);
    expect(backend.requests).toEqual([]);
  });

  it('passes the turn signal to the backend, and a stop mid-generate ends the call as stopped', async () => {
    const { backend, tool } = await setup();
    const ac = new AbortController();
    backend.during = (_p, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        setTimeout(() => ac.abort(), 5);
      });
    const result = (await tool('generate_image').execute({ prompt: 'p' }, ctx({ signal: ac.signal }))) as { code: string };
    expect(backend.signals[0]).toBe(ac.signal);
    expect(result.code).toBe('cancelled');
  });

  it('a backend failure is a plain error result', async () => {
    const { backend, tool } = await setup();
    backend.during = async () => {
      throw new Error('ComfyUI failed in KSampler: out of memory');
    };
    expect(await tool('generate_image').execute({ prompt: 'p' }, ctx())).toEqual({ error: true, code: 'generation_failed', message: 'ComfyUI failed in KSampler: out of memory' });
  });

  it('throttles progress to one per 500 ms, but every stage change goes out', async () => {
    const { backend, progress, tool } = await setup();
    backend.during = async (onProgress) => {
      onProgress({ stage: 'queued' });
      for (let i = 1; i <= 10; i++) onProgress({ stage: 'generating', step: i, steps: 10 });
      onProgress({ stage: 'saving' });
    };
    await tool('generate_image').execute({ prompt: 'p' }, ctx());
    expect(progress.map((e) => e.p)).toEqual([{ stage: 'queued' }, { stage: 'generating', step: 1, steps: 10 }, { stage: 'saving' }]);
    expect(progress[0]!.ctx.toolCallId).toBe('call-1');
  });

  it('a failure to resolve the backend ends the call before the ask', async () => {
    const host: MediaHost = {
      async backendFor() {
        throw new Error('The workflow this profile uses was deleted.');
      },
      ...noLimits,
    };
    const { asks, tool } = await setup({ host });
    expect(await tool('generate_image').execute({ prompt: 'p' }, ctx())).toEqual({ error: true, code: 'generation_unavailable', message: 'The workflow this profile uses was deleted.' });
    expect(asks).toEqual([]);
  });

  it('keeps the first output of the right media and notes the rest', async () => {
    const { backend, tool } = await setup();
    backend.outputs = [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), MP4, PNG, PNG];
    const result = (await tool('generate_image').execute({ prompt: 'p', seed: 1 }, ctx())) as Item[];
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(result[0]!.text).toMatch(/2 files .* left out/);
    expect(result[0]!.text).toMatch(/1 more image/);
  });

  it('refuses an image over the cap with a note naming its size, and stores nothing', async () => {
    const { backend, tool } = await setup();
    backend.outputs = [Buffer.concat([PNG, Buffer.alloc(MAX_TOOL_IMAGE_BYTES)])];
    const result = (await tool('generate_image').execute({ prompt: 'p' }, ctx())) as { error: boolean; code: string; message: string };
    expect(result).toMatchObject({ error: true, code: 'generation_failed' });
    expect(result.message).toContain('5.0 MB');
  });

  it('refuses output that is not on the allowlist', async () => {
    const { backend, tool } = await setup();
    backend.outputs = [Buffer.from('<html><body>hi</body></html>')];
    expect(await tool('generate_image').execute({ prompt: 'p' }, ctx())).toMatchObject({ error: true, code: 'generation_failed' });
  });

  describe('freeing the GPU', () => {
    it('runs once after Generate and before the backend, for the profile and the generation connection', async () => {
      const { backend, freed, tool } = await setup();
      await tool('generate_image').execute({ prompt: 'p' }, ctx());
      expect(freed).toEqual([{ profileId: 'p1', generationConnectionId: 'gen', backendRequests: 0 }]);
      expect(backend.requests).toHaveLength(1);
    });

    it('runs straight away with confirm prompts off', async () => {
      const { freed, tool } = await setup({ policy: policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } }) });
      await tool('generate_image').execute({ prompt: 'p' }, ctx({ unattended: true }));
      expect(freed).toHaveLength(1);
    });

    it('never runs on a cancel, a decline or an unattended refusal', async () => {
      for (const reply of [{ cancelled: true }, { reply: { declined: true } }, { unattended: true }] as AskOutcome[]) {
        const { freed, backend, tool } = await setup({ reply: () => reply });
        await tool('generate_image').execute({ prompt: 'p' }, ctx());
        expect(freed).toEqual([]);
        expect(backend.requests).toEqual([]);
      }
      const { freed, backend, tool } = await setup();
      await tool('generate_image').execute({ prompt: 'p' }, ctx({ unattended: true }));
      expect(freed).toEqual([]);
      expect(backend.requests).toEqual([]);
    });

    it('does not run with unloadChatModel off', async () => {
      const { freed, backend, tool } = await setup({ policy: policy({ media: { image: { connectionId: 'gen', model: 'm' }, unloadChatModel: false } }) });
      await tool('generate_image').execute({ prompt: 'p' }, ctx());
      expect(freed).toEqual([]);
      expect(backend.requests).toHaveLength(1);
    });

    it('a freeGpu that rejects still generates', async () => {
      const { backend, tool } = await setup({
        freeGpu: async () => {
          throw new Error('ollama is down');
        },
      });
      const result = (await tool('generate_image').execute({ prompt: 'p' }, ctx())) as Item[];
      expect(result[1]!.type).toBe('image');
      expect(backend.requests).toHaveLength(1);
    });
  });
});

describe('the ask and the result say exactly what is sent', () => {
  const SDXL = BUILTIN_WORKFLOWS.find((w) => w.id === 'builtin:sdxl-txt2img')!;
  const sdxl: Takes = { label: 'SDXL (ComfyUI)', ...workflowApplies(SDXL), workflowDefaults: true };
  const same = (input: AskInput): AskOutcome => {
    const a = input as { prompt: string; negativePrompt: string | null };
    return { reply: { generate: { prompt: a.prompt, negativePrompt: a.negativePrompt } } };
  };
  const text = (r: unknown) => (r as Item[])[0]!.text;
  const shown = (asks: AskInput[]) => asks.map((a) => [(a as { negativePrompt: unknown }).negativePrompt, (a as { settings: string }).settings]);

  it('A1111: shows and sends the negative, the seed and the size; an empty negative is sent as none', async () => {
    const { backend, asks, tool } = await setup({ takes: { label: 'sd15 (A1111)', applies: ALL, defaultNegativePrompt: null, workflowDefaults: false }, limits: { image: null }, reply: same });
    const r1 = await tool('generate_image').execute({ prompt: 'a cat', negative_prompt: 'blurry', seed: 7 }, ctx());
    const r2 = await tool('generate_image').execute({ prompt: 'a cat', seed: 8 }, ctx());
    expect(shown(asks)).toEqual([
      ['blurry', '1024×1024 · seed 7 · sd15 (A1111)'],
      ['', '1024×1024 · seed 8 · sd15 (A1111)'],
    ]);
    expect(backend.requests.map((r) => r.negativePrompt)).toEqual(['blurry', '']);
    expect(text(r1)).toBe('Generated an image with prompt: "a cat"; negative: "blurry"; seed 7; 1024×1024; sd15 (A1111).');
    expect(text(r2)).toBe('Generated an image with prompt: "a cat"; negative: none; seed 8; 1024×1024; sd15 (A1111).');
  });

  it('openai_images: no seed or negative anywhere, even when the model or the reply gives one', async () => {
    const { backend, asks, tool } = await setup({
      takes: { label: 'gpt-image-1 (OpenAI-style)', applies: OPENAI, defaultNegativePrompt: null, workflowDefaults: false },
      limits: { image: null },
      reply: (input) => ({ reply: { generate: { prompt: (input as { prompt: string }).prompt, negativePrompt: 'sneaked in' } } }),
    });
    const result = await tool('generate_image').execute({ prompt: 'a cat', negative_prompt: 'blurry', seed: 7 }, ctx());
    expect(asks[0]).toEqual({ kind: 'generation', toolName: 'generate_image', media: 'image', prompt: 'a cat', negativePrompt: null, settings: '1024×1024 · gpt-image-1 (OpenAI-style)' });
    expect(backend.requests[0]!.negativePrompt).toBeNull();
    expect(text(result)).toBe('Generated an image with prompt: "a cat"; 1024×1024; gpt-image-1 (OpenAI-style).');
  });

  it("ComfyUI SDXL: the workflow's own negative is prefilled and sent; the model's replaces it; cleared, '' is sent", async () => {
    const def = sdxl.defaultNegativePrompt!;
    expect(def).toMatch(/watermark/);
    let answer: string | null = def;
    const { backend, asks, tool } = await setup({
      takes: sdxl,
      reply: (input) => ({ reply: { generate: { prompt: (input as { prompt: string }).prompt, negativePrompt: answer } } }),
    });
    const kept = await tool('generate_image').execute({ prompt: 'a cat', seed: 1 }, ctx());
    answer = 'ugly';
    await tool('generate_image').execute({ prompt: 'a cat', negative_prompt: 'blurry', seed: 2 }, ctx());
    answer = null;
    const cleared = await tool('generate_image').execute({ prompt: 'a cat', seed: 3 }, ctx());
    expect(asks.map((a) => (a as { negativePrompt: unknown }).negativePrompt)).toEqual([def, 'blurry', def]);
    expect(backend.requests.map((r) => r.negativePrompt)).toEqual([def, 'ugly', '']);
    expect(text(kept)).toBe(`Generated an image with prompt: "a cat"; negative: ${JSON.stringify(def)}; seed 1; 1024×1024; SDXL (ComfyUI).`);
    expect(text(cleared)).toBe('Generated an image with prompt: "a cat"; negative: none; seed 3; 1024×1024; SDXL (ComfyUI).');
  });

  it('with confirm prompts off, sends the default negative a ComfyUI workflow would have shown', async () => {
    const { backend, tool } = await setup({ takes: sdxl, policy: policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } }) });
    await tool('generate_image').execute({ prompt: 'a cat' }, ctx());
    expect(backend.requests[0]!.negativePrompt).toBe(sdxl.defaultNegativePrompt);
  });

  it('an imported workflow with no seed, size or length binding says "workflow default" for each', async () => {
    const takes: Takes = { label: 'Mine (ComfyUI)', applies: { negativePrompt: false, seed: false, size: false, frames: false }, defaultNegativePrompt: null, workflowDefaults: true };
    const { backend, asks, tool } = await setup({ takes, reply: same });
    backend.outputs = [PNG];
    const image = await tool('generate_image').execute({ prompt: 'a cat', negative_prompt: 'blurry', seed: 7 }, ctx());
    backend.outputs = [MP4];
    const video = await tool('generate_video').execute({ prompt: 'a wave', seconds: 3 }, ctx());
    expect(shown(asks)).toEqual([
      [null, 'size: workflow default · seed: workflow default · Mine (ComfyUI)'],
      [null, 'size: workflow default · length: workflow default · seed: workflow default · Mine (ComfyUI)'],
    ]);
    expect(backend.requests[0]!.negativePrompt).toBeNull();
    expect(text(image)).toBe('Generated an image with prompt: "a cat"; seed: workflow default; size: workflow default; Mine (ComfyUI).');
    expect(text(video)).toBe('Generated a video with prompt: "a wave"; seed: workflow default; size: workflow default; length: workflow default; Mine (ComfyUI).');
  });

  it('a video names its length when the workflow takes one', async () => {
    const { backend, asks, tool } = await setup({ reply: same });
    backend.outputs = [MP4];
    const result = await tool('generate_video').execute({ prompt: 'a wave', seconds: 3, seed: 1 }, ctx());
    expect((asks[0] as { settings: string }).settings).toBe('960×960 · 3 s · seed 1 · SDXL (ComfyUI)');
    expect(text(result)).toBe('Generated a video with prompt: "a wave"; negative: none; seed 1; 960×960; 3 s; SDXL (ComfyUI).');
  });

  it("passes the profile's model file to the backend", async () => {
    const { backend, tool } = await setup({ policy: policy({ media: { image: { connectionId: 'gen', model: 'builtin:sdxl-txt2img', checkpoint: 'juggernaut.safetensors' } } }) });
    await tool('generate_image').execute({ prompt: 'p' }, ctx());
    expect(backend.requests[0]!.checkpoint).toBe('juggernaut.safetensors');
    const plain = await setup();
    await plain.tool('generate_image').execute({ prompt: 'p' }, ctx());
    expect(plain.backend.requests[0]).not.toHaveProperty('checkpoint');
  });
});

describe('the provider', () => {
  const emptyMcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };

  function provider(media?: MediaHost) {
    const store = new InMemoryStore();
    return new OtherBenchToolProvider(store, new PermissionBroker(store), emptyMcp, media ? { media } : {});
  }

  it('lists generate_image, gated, only with a media host and the profile choice', async () => {
    const backend = new FakeBackend();
    const host: MediaHost = { backendFor: async () => ({ backend, label: 'L', applies: ALL, defaultNegativePrompt: null, workflowDefaults: false }), ...noLimits };
    const imageOnly = policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } });
    const names = (await provider(host).listTools(imageOnly)).map((t) => t.name);
    expect(names).toContain('generate_image');
    expect(names).not.toContain('generate_video');
    expect((await provider().listTools(policy())).map((t) => t.name).filter((n) => n.startsWith('generate_'))).toEqual([]);
  });

  it('goes through the broker: a sub-agent call is refused and never reaches the backend', async () => {
    const backend = new FakeBackend();
    const p = provider({ backendFor: async () => ({ backend, label: 'L', applies: ALL, defaultNegativePrompt: null, workflowDefaults: false }), ...noLimits });
    const tool = (await p.listTools(policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } }))).find((t) => t.name === 'generate_image')!;
    const result = await tool.execute({ prompt: 'p' }, ctx({ subagent: { callId: 's', label: 'helper', parentProfileId: 'p1' } }));
    expect(result).toMatchObject({ error: true, code: 'permission_denied' });
    expect(backend.requests).toEqual([]);
  });

  it('relays progress as a progress event with the message and call id, and none without a call id', async () => {
    const backend = new FakeBackend();
    backend.during = async (onProgress) => onProgress({ stage: 'generating', step: 1, steps: 2 });
    const p = provider({ backendFor: async () => ({ backend, label: 'L', applies: ALL, defaultNegativePrompt: null, workflowDefaults: false }), ...noLimits });
    const events: ToolApprovalEvent[] = [];
    p.onApprovalEvent((e) => events.push(e));
    const tool = (await p.listTools(policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } }))).find((t) => t.name === 'generate_image')!;
    await tool.execute({ prompt: 'p' }, ctx());
    await tool.execute({ prompt: 'p' }, ctx({ toolCallId: undefined }));
    expect(events).toEqual([{ type: 'progress', messageId: 'msg-1', callId: 'call-1', progress: { stage: 'generating', step: 1, steps: 2 } }]);
  });

  it("audits the prompt and negative prompt that were sent, not the model's", async () => {
    const store = new InMemoryStore();
    const backend = new FakeBackend();
    const p = new OtherBenchToolProvider(store, new PermissionBroker(store), emptyMcp, {
      media: { backendFor: async () => ({ backend, label: 'L', applies: ALL, defaultNegativePrompt: null, workflowDefaults: false }), ...noLimits },
    });
    // The user edits the prompt in the card.
    p.onApprovalEvent((e) => {
      if (e.type === 'ask') p.answerAsk(e.ask.id, { generate: { prompt: 'the edited prompt', negativePrompt: 'blurry' } });
    });
    const tool = (await p.listTools(policy({ media: { image: { connectionId: 'gen', model: 'm' } } }))).find((t) => t.name === 'generate_image')!;
    await tool.execute({ prompt: 'the model prompt', seed: 3 }, ctx());
    expect(backend.requests[0]!.prompt).toBe('the edited prompt');
    expect(store.audit.list('chat-1').at(-1)!.argsRedacted).toEqual({ prompt: 'the edited prompt', negative_prompt: 'blurry', seed: 3 });
  });

  const takes = { label: 'L', applies: ALL, defaultNegativePrompt: null, workflowDefaults: false };

  it('is relayed to Claude Code for each choice the profile has, and only with a media host', async () => {
    const p = provider({ backendFor: async () => ({ backend: new FakeBackend(), ...takes }), ...noLimits });
    const imageOnly = policy({ media: { image: { connectionId: 'gen', model: 'm' } } });
    expect((await p.relayTools(imageOnly)).map((t) => [t.name, t.source, t.risk])).toEqual([['generate_image', 'media', 'execute']]);
    expect((await p.relayTools(policy())).map((t) => t.name)).toEqual(['generate_image', 'generate_video']);
    expect((await p.relayTools(policy({ media: undefined }))).map((t) => t.name)).toEqual([]);
    expect((await provider().relayTools(policy())).map((t) => t.name)).toEqual([]);
  });

  it('describes a relayed call as a fresh plain copy of the model arguments, risk execute', async () => {
    const p = provider({ backendFor: async () => ({ backend: new FakeBackend(), ...takes }), ...noLimits });
    const spec = (await p.relayTools(policy())).find((t) => t.name === 'generate_image')!;
    const raw = { prompt: 'a red cube', seed: 7 };
    const described = (await spec.describeCall!(raw, ctx())) as { args: Record<string, unknown>; risk: string };
    expect(described).toEqual({ args: raw, risk: 'execute' });
    expect(described.args).not.toBe(raw);
    expect(Object.getPrototypeOf(described.args)).toBe(Object.prototype);
    expect(await spec.describeCall!('nope', ctx())).toEqual({ args: {}, risk: 'execute' });
  });

  it('runs a relayed call only with arguments requestApproval approved, once', async () => {
    const backend = new FakeBackend();
    const p = provider({ backendFor: async () => ({ backend, ...takes }), ...noLimits });
    const pol = policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } });
    const spec = (await p.relayTools(pol)).find((t) => t.name === 'generate_image')!;
    const refusal = { error: true, code: 'no_approval' };
    expect(await spec.execute({ prompt: 'p' }, ctx())).toMatchObject(refusal);
    const outcome = await p.requestApproval(spec, { prompt: 'p' }, pol, ctx());
    if (!('allowed' in outcome) || !outcome.allowed) throw new Error('expected an approval');
    expect(await spec.execute(structuredClone(outcome.args), ctx())).toMatchObject(refusal);
    expect(backend.requests).toEqual([]);
    const ran = (await spec.execute(outcome.args, ctx())) as Item[];
    expect(ran[1]!.type).toBe('image');
    expect(backend.requests).toHaveLength(1);
    expect(await spec.execute(outcome.args, ctx())).toMatchObject(refusal);
    expect(backend.requests).toHaveLength(1);
  });
});
