import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL } from '../playwright.config.js';

/**
 * Image and video generation end to end (spec 2026-10-22-media-generation-design),
 * with the mock model: `#image <prompt>` and `#video <prompt>` make it call the
 * real generate_image / generate_video tool, and it then says "Done.".
 *
 * The generators are fakes started here on a free loopback port: an
 * `openai_images` server that answers with a 1x1 PNG, and a ComfyUI with no
 * websocket (the client polls /history every second) that serves a tiny mp4
 * (fixtures/tiny.mp4: VP9 in an mp4 box, so the test browser can play it).
 */

test.describe.configure({ mode: 'serial' });

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** A tiny image workflow, as ComfyUI keeps it in /history for a run from its own page (API format). */
const TINY_IMAGE_GRAPH = {
  '3': { class_type: 'KSampler', inputs: { seed: 7, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'tiny.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'tiny', images: ['8', 0] } },
};
const TEMPLATE_INDEX = [
  {
    moduleName: 'default',
    title: 'Image',
    type: 'image',
    templates: [{ name: 'image_tiny_text', title: 'Tiny text to image', mediaType: 'image', io: { inputs: [], outputs: [{ mediaType: 'image' }] }, models: ['tiny.safetensors'] }],
  },
];
const MP4 = readFileSync(fileURLToPath(new URL('./fixtures/tiny.mp4', import.meta.url)));

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** The prompts the fake image server was asked for, to prove the edited text is what was sent. */
const imagePrompts: string[] = [];
/** The workflows the fake ComfyUI was given. */
const comfyPrompts: string[] = [];
let imageServer: Server;
let imagePort = 0;
let comfyServer: Server;
let comfyPort = 0;

test.beforeAll(async () => {
  ({ server: imageServer, port: imagePort } = await listen((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/v1/models') return json(res, { data: [{ id: 'fake-image' }] });
    if (req.method === 'POST' && url === '/v1/images/generations') {
      void body(req).then((text) => {
        imagePrompts.push((JSON.parse(text) as { prompt?: string }).prompt ?? '');
        json(res, { data: [{ b64_json: PNG_1X1.toString('base64') }] });
      });
      return;
    }
    json(res, { error: 'not found' }, 404);
  }));

  ({ server: comfyServer, port: comfyPort } = await listen((req, res) => {
    const url = (req.url ?? '').split('?')[0]!;
    if (req.method === 'GET' && url === '/system_stats') return json(res, { system: { os: 'fake' }, devices: [] });
    if (req.method === 'POST' && url === '/prompt') {
      void body(req).then((text) => {
        comfyPrompts.push(text);
        json(res, { prompt_id: text.includes('EmptyLatentImage') ? 'fake-image-job' : 'fake-job', number: 1 });
      });
      return;
    }
    if (req.method === 'GET' && url === '/history') {
      return json(res, {
        'run-from-comfy': {
          prompt: [1, 'run-from-comfy', TINY_IMAGE_GRAPH, { create_time: 1_700_000_000_000, extra_pnginfo: { workflow: { nodes: [], links: [] } } }, ['9']],
          outputs: { '9': { images: [{ filename: 'tiny.png', subfolder: '', type: 'output' }] } },
          status: { status_str: 'success', messages: [] },
        },
      });
    }
    if (req.method === 'GET' && url === '/templates/index.json') return json(res, TEMPLATE_INDEX);
    if (req.method === 'GET' && url === '/history/fake-image-job') {
      return json(res, {
        'fake-image-job': { status: { status_str: 'success', messages: [] }, outputs: { '9': { images: [{ filename: 'tiny.png', subfolder: '', type: 'output' }] } } },
      });
    }
    if (req.method === 'GET' && url.startsWith('/history/')) {
      return json(res, {
        'fake-job': { status: { status_str: 'success', messages: [] }, outputs: { '58': { images: [{ filename: 'video.mp4', subfolder: 'video', type: 'output' }] } } },
      });
    }
    if (req.method === 'GET' && url === '/view') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return void res.end((req.url ?? '').includes('tiny.png') ? PNG_1X1 : MP4);
    }
    if (url === '/queue' || url === '/interrupt') return json(res, {});
    // /ws gets a plain 404: no websocket, so the client polls.
    json(res, { error: 'not found' }, 404);
  }));
});

test.afterAll(async () => {
  await Promise.all([imageServer, comfyServer].map((s) => new Promise((resolve) => (s ? s.close(resolve) : resolve(undefined)))));
});

async function seedChat(request: APIRequestContext, kind: 'image' | 'video'): Promise<{ chatId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const mock = await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } });
  expect(mock.ok()).toBeTruthy();
  const { id: connectionId } = (await mock.json()) as { id: string };

  const gen = await request.post(`${BASE_URL}/api/connections`, {
    data:
      kind === 'image'
        ? { name: `Images ${suffix}`, kind: 'openai_images', baseUrl: `http://127.0.0.1:${imagePort}/v1` }
        : { name: `ComfyUI ${suffix}`, kind: 'comfyui', baseUrl: `http://127.0.0.1:${comfyPort}` },
  });
  expect(gen.ok()).toBeTruthy();
  const { id: genId } = (await gen.json()) as { id: string };

  const media = kind === 'image' ? { image: { connectionId: genId, model: 'fake-image' } } : { video: { connectionId: genId, model: 'builtin:wan22-5b-t2v' } };
  const profile = await request.post(`${BASE_URL}/api/profiles`, {
    data: {
      name: `Media ${suffix}`,
      connectionId,
      modelId: 'mock-standard',
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', media },
    },
  });
  expect(profile.ok()).toBeTruthy();
  const { id: profileId } = (await profile.json()) as { id: string };
  const chat = await request.post(`${BASE_URL}/api/chats`, { data: { title: `Media E2E ${suffix}`, profileId, workspaceRoot: null } });
  expect(chat.ok()).toBeTruthy();
  return { chatId: ((await chat.json()) as { id: string }).id };
}

async function openChat(page: Page, chatId: string): Promise<void> {
  await page.getByTestId(`chat-row-${chatId}`).locator('[data-row-main]').click();
}

async function send(page: Page, chatId: string, text: string): Promise<void> {
  await page.goto('/');
  await openChat(page, chatId);
  const textbox = page.getByRole('textbox', { name: /message/i });
  await textbox.fill(text);
  await textbox.press('Enter');
}

test('#image: the prompt ask shows the prompt, the edited prompt is what is sent, and the image stays after a reload', async ({ page, request }) => {
  test.setTimeout(60_000);
  const { chatId } = await seedChat(request, 'image');
  await send(page, chatId, '#image a red cube');

  const card = page.locator('[data-testid^="ask-card-"][data-kind="generation"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('a red cube');
  // An OpenAI-style images API takes no seed or negative prompt, so the card names neither.
  await expect(card).not.toContainText('Negative prompt');
  await expect(card).not.toContainText('seed');
  // Nothing has reached the generator while the ask is open.
  expect(imagePrompts).toEqual([]);

  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByRole('textbox', { name: 'Prompt' }).fill('a blue cube');
  await card.getByRole('button', { name: 'Generate' }).click();

  await expect(page.getByTestId('generated-image')).toBeVisible();
  await expect(page.getByTestId('generated-media')).toContainText('"a blue cube"');
  await expect(page.getByTestId('generated-media')).not.toContainText(/seed|negative/);
  expect(imagePrompts).toEqual(['a blue cube']);
  await expect(page.locator('article[data-role="assistant"] .markdown-body')).toContainText('Done.');

  await page.reload();
  await openChat(page, chatId);
  const image = page.getByTestId('generated-image');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
});

test('#video: the same flow through ComfyUI gives a playing video that stays after a reload', async ({ page, request }) => {
  test.setTimeout(90_000);
  const { chatId } = await seedChat(request, 'video');
  await send(page, chatId, '#video a wave');

  const card = page.locator('[data-testid^="ask-card-"][data-kind="generation"]');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('a wave');
  // The workflow's own negative prompt is shown, to keep or edit, and so is the seed.
  await expect(card).toContainText('Negative prompt');
  await expect(card).toContainText('seed');
  expect(comfyPrompts).toEqual([]);

  await card.getByRole('button', { name: 'Edit' }).click();
  await card.getByRole('textbox', { name: 'Prompt', exact: true }).fill('a big wave');
  await card.getByRole('button', { name: 'Generate' }).click();

  await expect(page.getByTestId('generated-video')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('generated-media')).toContainText('"a big wave"');
  expect(comfyPrompts).toHaveLength(1);
  expect(comfyPrompts[0]).toContain('a big wave');
  // The negative prompt shown is the one sent: the workflow's own, left as it was.
  expect(comfyPrompts[0]).toContain('色调艳丽');

  await page.reload();
  await openChat(page, chatId);
  const video = page.getByTestId('generated-video');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && v.videoWidth > 0)).toBe(true);
});

test('a workflow run from ComfyUI is added from Recently run, picked on a profile, and generates an image', async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = randomUUID().slice(0, 8);
  const connectionName = `ComfyUI fit ${suffix}`;
  const workflowName = `Tiny image ${suffix}`;
  const mock = (await (await request.post(`${BASE_URL}/api/connections`, { data: { name: `Mock ${suffix}`, kind: 'mock' } })).json()) as { id: string };
  const comfy = (await (await request.post(`${BASE_URL}/api/connections`, { data: { name: connectionName, kind: 'comfyui', baseUrl: `http://127.0.0.1:${comfyPort}` } })).json()) as { id: string };
  const profileRes = await request.post(`${BASE_URL}/api/profiles`, {
    data: {
      name: `Fit ${suffix}`,
      connectionId: mock.id,
      modelId: 'mock-standard',
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', media: { image: { connectionId: comfy.id, model: 'builtin:sdxl-txt2img' } } },
    },
  });
  expect(profileRes.ok()).toBeTruthy();
  const profile = (await profileRes.json()) as { id: string };
  const chatRes = await request.post(`${BASE_URL}/api/chats`, { data: { title: `Fit E2E ${suffix}`, profileId: profile.id, workspaceRoot: null } });
  const { id: chatId } = (await chatRes.json()) as { id: string };

  // Part 1: the run from ComfyUI's page is listed, added after a review, and then listed as added.
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Connections' }).click();
  await page.getByTestId('connections-list').getByText(connectionName).click();
  const section = page.getByTestId('workflows-section');
  await expect(section.getByRole('tab', { name: 'Recently run' })).toHaveAttribute('aria-selected', 'true');
  const recent = section.getByTestId('recent-run-from-comfy');
  await expect(recent).toBeVisible();
  await recent.getByRole('button', { name: 'Add' }).click();
  const review = page.getByTestId('workflow-review');
  await review.getByRole('textbox', { name: 'Workflow name' }).fill(workflowName);
  await review.getByRole('button', { name: 'Save workflow' }).click();
  await expect(review).toHaveCount(0);
  await expect(recent).toContainText('Added');
  await section.getByRole('tab', { name: 'Added to OtherBench' }).click();
  await expect(section).toContainText(workflowName);
  // The text-only template is listed too (it is only opened in ComfyUI, never run from here).
  await section.getByRole('tab', { name: 'Templates' }).click();
  await expect(section).toContainText('Tiny text to image');

  // Part 2: the profile uses it, and #image runs it.
  await page.getByRole('tab', { name: 'Profiles' }).click();
  await page.getByTestId(`profile-row-${profile.id}`).click();
  await page.getByLabel('Image workflow').selectOption({ label: workflowName });
  await page.getByTestId('profile-form').getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => ((await (await request.get(`${BASE_URL}/api/profiles/${profile.id}`)).json()) as { toolPolicy: { media?: { image?: { model: string } } } }).toolPolicy.media?.image?.model)
    .not.toBe('builtin:sdxl-txt2img');

  const before = comfyPrompts.length;
  await send(page, chatId, '#image a green cube');
  const card = page.locator('[data-testid^="ask-card-"][data-kind="generation"]');
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByTestId('generated-image')).toBeVisible({ timeout: 30_000 });
  expect(comfyPrompts).toHaveLength(before + 1);
  expect(comfyPrompts[before]).toContain('a green cube');
  expect(comfyPrompts[before]).toContain('tiny.safetensors');
});
