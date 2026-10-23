import { describe, it, expect } from 'vitest';
import { GENERATION_KINDS, confirmPromptsOf, hasUserinfo, isGenerationKind, withoutUserinfo } from '../src/domain/media.js';
import { subagentPolicy } from '../src/domain/subagent.js';
import type { ToolPolicy } from '../src/types/config.js';

const BASE: ToolPolicy = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' };

describe('isGenerationKind', () => {
  it('is true for the three generation kinds and false for chat kinds', () => {
    expect([...GENERATION_KINDS].sort()).toEqual(['a1111', 'comfyui', 'openai_images']);
    expect(isGenerationKind('comfyui')).toBe(true);
    expect(isGenerationKind('a1111')).toBe(true);
    expect(isGenerationKind('openai_images')).toBe(true);
    expect(isGenerationKind('ollama')).toBe(false);
    expect(isGenerationKind('mock')).toBe(false);
  });
});

describe('confirmPromptsOf', () => {
  it('defaults to true and is false only when set false', () => {
    expect(confirmPromptsOf({ ...BASE })).toBe(true);
    expect(confirmPromptsOf({ ...BASE, media: {} })).toBe(true);
    expect(confirmPromptsOf({ ...BASE, media: { confirmPrompts: true } })).toBe(true);
    expect(confirmPromptsOf({ ...BASE, media: { confirmPrompts: false } })).toBe(false);
  });
});

describe('subagentPolicy and media', () => {
  it('never gives a sub-agent the media tools', () => {
    const media = { image: { connectionId: 'c', model: 'builtin:sdxl-txt2img' }, confirmPrompts: false };
    const parent: ToolPolicy = { ...BASE, media };
    const out = subagentPolicy(parent, { ...BASE, media });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.policy.media).toBeUndefined();
  });
});

describe('userinfo in base URLs', () => {
  it('spots a user or password in a URL', () => {
    expect(hasUserinfo('http://user:pass@127.0.0.1:7860')).toBe(true);
    expect(hasUserinfo('http://user@127.0.0.1:7860')).toBe(true);
    expect(hasUserinfo('http://127.0.0.1:7860')).toBe(false);
    expect(hasUserinfo('not a url')).toBe(false);
  });

  it('takes every user:pass@ out of a message, the password with an @ in it included', () => {
    expect(withoutUserinfo('http://user:p@ss@127.0.0.1:7860')).toBe('http://127.0.0.1:7860');
    expect(withoutUserinfo("Couldn't reach https://a:b@host/v1: Request cannot be constructed from a URL that includes credentials: https://a:b@host/v1/models")).toBe(
      "Couldn't reach https://host/v1: Request cannot be constructed from a URL that includes credentials: https://host/v1/models",
    );
    expect(withoutUserinfo('http://127.0.0.1:8188 said no')).toBe('http://127.0.0.1:8188 said no');
  });
});
