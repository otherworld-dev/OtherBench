import { describe, it, expect } from 'vitest';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import { MAX_TOOL_IMAGE_BYTES } from '@otherbench/core/domain/tool-images.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { MediaBackend, MediaProgress, MediaRequest } from '@otherbench/core/ports/media.js';
import type { AskInput, AskOutcome, ToolApprovalEvent, ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { ToolPolicy } from '@otherbench/core/types/config.js';
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

function setup(opts: { reply?: (input: AskInput) => AskOutcome; host?: MediaHost; policy?: ToolPolicy } = {}) {
  const backend = new FakeBackend();
  const asks: AskInput[] = [];
  const progress: { ctx: ToolContext; p: MediaProgress }[] = [];
  const used: { connectionId: string; media: string; model: string }[] = [];
  const host: MediaHost = opts.host ?? {
    async backendFor(connectionId, use) {
      used.push({ connectionId, ...use });
      return { backend, label: 'SDXL (ComfyUI)' };
    },
  };
  const reply = opts.reply ?? ((input: AskInput) => ({ reply: { generate: { prompt: (input as { prompt: string }).prompt, negativePrompt: null } } }));
  const tools = mediaTools(
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
  return { backend, asks, progress, used, tools, tool };
}

type Item = { type: string; text?: string; data?: string; mimeType?: string };

describe('generate_image / generate_video', () => {
  it('offers each tool only when the profile has that choice, as source media with risk execute', () => {
    expect(setup().tools.map((t) => [t.name, t.source, t.risk])).toEqual([
      ['generate_image', 'media', 'execute'],
      ['generate_video', 'media', 'execute'],
    ]);
    expect(setup({ policy: policy({ media: { image: { connectionId: 'gen', model: 'm' } } }) }).tools.map((t) => t.name)).toEqual(['generate_image']);
    expect(setup({ policy: policy({ media: undefined }) }).tools).toEqual([]);
  });

  it('tells the model to write a full prompt and that the user sees it first', () => {
    const { tool } = setup();
    expect(tool('generate_image').description).toMatch(/subject.*style.*lighting.*composition/is);
    expect(tool('generate_image').description).toMatch(/user sees/i);
  });

  it('asks with the model prompt, then sends and reports the edited one', async () => {
    const { backend, asks, tool } = setup({ reply: () => ({ reply: { generate: { prompt: 'edited', negativePrompt: null } } }) });
    const result = (await tool('generate_image').execute({ prompt: 'a red cube', negative_prompt: 'blurry', seed: 7 }, ctx())) as Item[];
    expect(asks).toEqual([
      { kind: 'generation', toolName: 'generate_image', media: 'image', prompt: 'a red cube', negativePrompt: 'blurry', settings: '1024×1024 · seed 7 · SDXL (ComfyUI)' },
    ]);
    expect(backend.requests[0]).toMatchObject({ media: 'image', model: 'builtin:sdxl-txt2img', prompt: 'edited', negativePrompt: null, width: 1024, height: 1024, seed: 7 });
    expect(result[0]!.type).toBe('text');
    expect(result[0]!.text).toBe('Generated an image with prompt: "edited"; negative: none; seed 7; 1024×1024; SDXL (ComfyUI).');
    expect(result[1]).toEqual({ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
  });

  it('a decline returns generation_cancelled and never calls the backend', async () => {
    const { backend, tool } = setup({ reply: () => ({ reply: { declined: true } }) });
    const result = await tool('generate_image').execute({ prompt: 'a red cube' }, ctx());
    expect(result).toEqual({ error: true, code: 'generation_cancelled', message: "The user cancelled this generation. Don't try again unless they ask." });
    expect(backend.requests).toEqual([]);
  });

  it('unattended with confirm prompts on returns approval_unavailable and never calls the backend', async () => {
    const { backend, tool } = setup({ reply: () => ({ unattended: true }) });
    const result = await tool('generate_image').execute({ prompt: 'a red cube' }, ctx({ unattended: true }));
    expect(result).toEqual({ error: true, code: 'approval_unavailable', message: 'Nobody is here to check the prompt, so nothing was generated.' });
    expect(backend.requests).toEqual([]);
  });

  it('a stopped turn at the ask ends as stopped, not as a decline', async () => {
    const { backend, tool } = setup({ reply: () => ({ cancelled: true }) });
    const result = (await tool('generate_image').execute({ prompt: 'a red cube' }, ctx())) as { code: string };
    expect(result.code).toBe('cancelled');
    expect(backend.requests).toEqual([]);
  });

  it('with confirm prompts off, makes no ask and sends the model prompt, unattended included', async () => {
    const { backend, asks, tool } = setup({ policy: policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } }) });
    await tool('generate_image').execute({ prompt: 'a red cube' }, ctx({ unattended: true }));
    expect(asks).toEqual([]);
    expect(backend.requests[0]!.prompt).toBe('a red cube');
  });

  it('sizes by aspect', async () => {
    const { backend, tool } = setup();
    await tool('generate_image').execute({ prompt: 'p', aspect: 'portrait' }, ctx());
    await tool('generate_image').execute({ prompt: 'p', aspect: 'wide' }, ctx());
    await tool('generate_video').execute({ prompt: 'p', aspect: 'landscape' }, ctx());
    expect(backend.requests.map((r) => [r.width, r.height])).toEqual([
      [832, 1216],
      [1344, 768],
      [832, 480],
    ]);
  });

  it('seconds: 3 sends 73 frames; video defaults to 5 seconds', async () => {
    const { backend, tool } = setup();
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
    const { backend, asks, tool } = setup();
    const result = (await tool('generate_image').execute({ prompt: 'p' }, ctx())) as Item[];
    const seed = backend.requests[0]!.seed;
    expect(Number.isSafeInteger(seed) && seed >= 0).toBe(true);
    expect((asks[0] as { settings: string }).settings).toContain(`seed ${seed}`);
    expect(result[0]!.text).toContain(`seed ${seed};`);
  });

  it('refuses bad arguments before anything else', async () => {
    const { backend, asks, tool } = setup();
    for (const args of [{}, { prompt: '  ' }, { prompt: 'p', aspect: 'tall' }, { prompt: 'p', seed: -1 }, { prompt: 'p', seed: 1.5 }, { prompt: 'x'.repeat(4001) }]) {
      expect(await tool('generate_image').execute(args, ctx())).toMatchObject({ error: true, code: 'invalid_input' });
    }
    for (const seconds of [0, 11, 2.5]) {
      expect(await tool('generate_video').execute({ prompt: 'p', seconds }, ctx())).toMatchObject({ error: true, code: 'invalid_input' });
    }
    expect(asks).toEqual([]);
    expect(backend.requests).toEqual([]);
  });

  it('passes the turn signal to the backend, and a stop mid-generate ends the call as stopped', async () => {
    const { backend, tool } = setup();
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
    const { backend, tool } = setup();
    backend.during = async () => {
      throw new Error('ComfyUI failed in KSampler: out of memory');
    };
    expect(await tool('generate_image').execute({ prompt: 'p' }, ctx())).toEqual({ error: true, code: 'generation_failed', message: 'ComfyUI failed in KSampler: out of memory' });
  });

  it('throttles progress to one per 500 ms, but every stage change goes out', async () => {
    const { backend, progress, tool } = setup();
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
    };
    const { asks, tool } = setup({ host });
    expect(await tool('generate_image').execute({ prompt: 'p' }, ctx())).toEqual({ error: true, code: 'generation_unavailable', message: 'The workflow this profile uses was deleted.' });
    expect(asks).toEqual([]);
  });

  it('keeps the first output of the right media and notes the rest', async () => {
    const { backend, tool } = setup();
    backend.outputs = [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), MP4, PNG, PNG];
    const result = (await tool('generate_image').execute({ prompt: 'p', seed: 1 }, ctx())) as Item[];
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(result[0]!.text).toMatch(/2 files .* left out/);
    expect(result[0]!.text).toMatch(/1 more image/);
  });

  it('refuses an image over the cap with a note naming its size, and stores nothing', async () => {
    const { backend, tool } = setup();
    backend.outputs = [Buffer.concat([PNG, Buffer.alloc(MAX_TOOL_IMAGE_BYTES)])];
    const result = (await tool('generate_image').execute({ prompt: 'p' }, ctx())) as { error: boolean; code: string; message: string };
    expect(result).toMatchObject({ error: true, code: 'generation_failed' });
    expect(result.message).toContain('5.0 MB');
  });

  it('refuses output that is not on the allowlist', async () => {
    const { backend, tool } = setup();
    backend.outputs = [Buffer.from('<html><body>hi</body></html>')];
    expect(await tool('generate_image').execute({ prompt: 'p' }, ctx())).toMatchObject({ error: true, code: 'generation_failed' });
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
    const host: MediaHost = { backendFor: async () => ({ backend, label: 'L' }) };
    const imageOnly = policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } });
    const names = (await provider(host).listTools(imageOnly)).map((t) => t.name);
    expect(names).toContain('generate_image');
    expect(names).not.toContain('generate_video');
    expect((await provider().listTools(policy())).map((t) => t.name).filter((n) => n.startsWith('generate_'))).toEqual([]);
  });

  it('goes through the broker: a sub-agent call is refused and never reaches the backend', async () => {
    const backend = new FakeBackend();
    const p = provider({ backendFor: async () => ({ backend, label: 'L' }) });
    const tool = (await p.listTools(policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } }))).find((t) => t.name === 'generate_image')!;
    const result = await tool.execute({ prompt: 'p' }, ctx({ subagent: { callId: 's', label: 'helper', parentProfileId: 'p1' } }));
    expect(result).toMatchObject({ error: true, code: 'permission_denied' });
    expect(backend.requests).toEqual([]);
  });

  it('relays progress as a progress event with the message and call id, and none without a call id', async () => {
    const backend = new FakeBackend();
    backend.during = async (onProgress) => onProgress({ stage: 'generating', step: 1, steps: 2 });
    const p = provider({ backendFor: async () => ({ backend, label: 'L' }) });
    const events: ToolApprovalEvent[] = [];
    p.onApprovalEvent((e) => events.push(e));
    const tool = (await p.listTools(policy({ media: { image: { connectionId: 'gen', model: 'm' }, confirmPrompts: false } }))).find((t) => t.name === 'generate_image')!;
    await tool.execute({ prompt: 'p' }, ctx());
    await tool.execute({ prompt: 'p' }, ctx({ toolCallId: undefined }));
    expect(events).toEqual([{ type: 'progress', messageId: 'msg-1', callId: 'call-1', progress: { stage: 'generating', step: 1, steps: 2 } }]);
  });

  it('is not relayed to Claude Code', () => {
    const p = provider({ backendFor: async () => ({ backend: new FakeBackend(), label: 'L' }) });
    expect(p.relayTools(policy()).map((t) => t.name)).toEqual([]);
  });
});
