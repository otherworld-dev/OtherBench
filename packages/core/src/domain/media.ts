import type { Connection, ToolPolicy } from '../types/config.js';

/**
 * Connection kinds that generate images or video. They are never routed a
 * chat turn, listed as a chat model, or accepted as a profile's chat
 * connection.
 */
export const GENERATION_KINDS: readonly Connection['kind'][] = ['comfyui', 'a1111', 'openai_images'];

export function isGenerationKind(kind: Connection['kind']): boolean {
  return GENERATION_KINDS.includes(kind);
}

/** Whether a generation call shows its prompt in the ask (and refuses unattended runs). Absent means true. */
export function confirmPromptsOf(policy: ToolPolicy): boolean {
  return policy.media?.confirmPrompts !== false;
}
