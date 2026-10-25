import type { Connection, ToolPolicy } from '../types/config.js';
import { isLoopbackUrl } from './availability.js';

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

/** Whether a profile frees a local chat model's GPU memory before a generation. Absent means true. */
export function unloadChatModelOf(policy: ToolPolicy): boolean {
  return policy.media?.unloadChatModel !== false;
}

/** Whether the chat model and the generation backend both run on this machine, so they share its GPU. */
export function sharesLocalGpu(chat: Pick<Connection, 'kind' | 'baseUrl'>, generation: Pick<Connection, 'baseUrl'>): boolean {
  return chat.kind === 'ollama' && isLoopbackUrl(chat.baseUrl ?? 'http://127.0.0.1:11434') && isLoopbackUrl(generation.baseUrl ?? '');
}

// `scheme://` then everything up to the last `@` before the path: a password may hold an `@`.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi;

/** Whether a URL carries a user or password (`http://user:pass@host`). */
export function hasUserinfo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return false;
  }
}

/** `text` with the `user:pass@` taken out of every URL in it: for messages that name a base URL. */
export function withoutUserinfo(text: string): string {
  return text.replace(USERINFO, '$1');
}
