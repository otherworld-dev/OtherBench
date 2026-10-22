/**
 * The port for local image and video generation backends (ComfyUI, A1111,
 * OpenAI-style image servers). Adapters live in `packages/tools/src/media/`.
 */

export interface MediaRequest {
  media: 'image' | 'video';
  model: string;
  prompt: string;
  negativePrompt: string | null;
  width: number;
  height: number;
  /** The tool picks a random one when the model gives none. */
  seed: number;
  /** Video only. */
  frames?: number;
}

export type MediaProgress = { stage: 'queued' | 'generating' | 'saving'; step?: number; steps?: number };

/** Typed later by sniffing the bytes, never by the backend. */
export interface MediaOutput {
  bytes: Buffer;
}

export interface MediaBackend {
  generate(req: MediaRequest, onProgress: (p: MediaProgress) => void, signal: AbortSignal): Promise<MediaOutput[]>;
  /** Throws a plain-English Error when the backend can't be used. */
  test(signal: AbortSignal): Promise<void>;
  listModels(media: 'image' | 'video', signal: AbortSignal): Promise<{ id: string; label: string }[]>;
}

export interface MediaConnection {
  kind: 'comfyui' | 'a1111' | 'openai_images';
  baseUrl: string;
  apiKey: string | null;
  extraHeaders: Record<string, string>;
}
