/**
 * Wan 2.2 5B text to video, after ComfyUI's stock "Wan 2.2 5B text to video"
 * template (the TI2V model with no start image), in API format. Saves an
 * mp4 (h264) with the core SaveVideo node, at Wan 2.2's 24 fps.
 *
 * Needs:
 * - `models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`
 * - `models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
 * - `models/vae/wan2.2_vae.safetensors`
 */
import type { MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';

// The template's own negative prompt; Wan was trained with it in Chinese.
const NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

export const WAN22_5B_T2V: MediaWorkflow = {
  id: 'builtin:wan22-5b-t2v',
  name: 'Wan 2.2 5B',
  media: 'video',
  builtin: true,
  graph: {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 0,
        steps: 20,
        cfg: 5,
        sampler_name: 'uni_pc',
        scheduler: 'simple',
        denoise: 1,
        model: ['48', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['55', 0],
      },
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['38', 0] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip: ['38', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['39', 0] } },
    '37': { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' } },
    '38': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' },
    },
    '39': { class_type: 'VAELoader', inputs: { vae_name: 'wan2.2_vae.safetensors' } },
    '48': { class_type: 'ModelSamplingSD3', inputs: { shift: 8, model: ['37', 0] } },
    '55': {
      class_type: 'Wan22ImageToVideoLatent',
      inputs: { width: 1280, height: 704, length: 121, batch_size: 1, vae: ['39', 0] },
    },
    '57': { class_type: 'CreateVideo', inputs: { fps: 24, images: ['8', 0] } },
    '58': {
      class_type: 'SaveVideo',
      inputs: { filename_prefix: 'video/OtherBench', format: 'mp4', codec: 'h264', video: ['57', 0] },
    },
  },
  bindings: {
    prompt: { nodeId: '6', input: 'text' },
    negativePrompt: { nodeId: '7', input: 'text' },
    seed: { nodeId: '3', input: 'seed' },
    width: { nodeId: '55', input: 'width' },
    height: { nodeId: '55', input: 'height' },
    frames: { nodeId: '55', input: 'length' },
    checkpoint: { nodeId: '37', input: 'unet_name' },
  },
};
