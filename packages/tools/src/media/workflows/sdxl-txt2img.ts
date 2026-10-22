/**
 * SDXL text to image, after ComfyUI's stock "SDXL simple" template (base
 * model only, no refiner), in API format.
 *
 * Needs `models/checkpoints/sd_xl_base_1.0.safetensors`.
 */
import type { MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';

export const SDXL_TXT2IMG: MediaWorkflow = {
  id: 'builtin:sdxl-txt2img',
  name: 'SDXL',
  media: 'image',
  builtin: true,
  graph: {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 25,
        cfg: 7,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark, blurry, low quality', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'OtherBench', images: ['8', 0] } },
  },
  bindings: {
    prompt: { nodeId: '6', input: 'text' },
    negativePrompt: { nodeId: '7', input: 'text' },
    seed: { nodeId: '3', input: 'seed' },
    width: { nodeId: '5', input: 'width' },
    height: { nodeId: '5', input: 'height' },
    checkpoint: { nodeId: '4', input: 'ckpt_name' },
  },
};
