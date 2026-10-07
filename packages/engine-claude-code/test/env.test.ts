import { describe, expect, it } from 'vitest';
import type { Connection } from '@grunt/core/types/config.js';
import { backendOf, buildChildEnv } from '../src/env.js';

const conn = (baseUrl: string | null): Connection => ({ id: 'c', name: 'CC', kind: 'claude_code', baseUrl, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });

describe('env', () => {
  it('names the backend', () => {
    expect(backendOf(conn(null))).toBe('claude');
    expect(backendOf(conn('http://localhost:11434/'))).toBe('http://localhost:11434');
  });
  it('strips API credentials in any case for the Claude login', () => {
    const env = buildChildEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', anthropic_auth_token: 't', Anthropic_Base_Url: 'x' }, conn(null), null, 'sonnet');
    expect(env).toEqual({ PATH: '/bin' });
  });
  it.each([null, 'http://localhost:11434'])('drops parent Claude Code session variables in any case (base URL %s)', (baseUrl) => {
    const env = buildChildEnv({ PATH: '/bin', CLAUDECODE: '1', claude_code_entrypoint: 'cli', Claude_Code_SSE_Port: '1234', CLAUDE_CONFIG_DIR: '/cfg' }, conn(baseUrl), null, 'm');
    for (const k of Object.keys(env)) expect(k).not.toMatch(/^(claudecode|claude_code_entrypoint|claude_code_sse_port)$/i);
    expect(env).toMatchObject({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg' });
  });
  it("never lets an extra folder's CLAUDE.md load, whatever Grunt's own environment says", () => {
    const env = buildChildEnv({ PATH: '/bin', claude_code_additional_directories_claude_md: '1' }, conn(null), null, 'sonnet');
    expect(env).toEqual({ PATH: '/bin' });
  });
  it('points Claude Code at an endpoint with a token and the chosen model for background calls', () => {
    const env = buildChildEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k' }, conn('http://localhost:11434/'), null, 'qwen3-coder:30b');
    expect(env).toMatchObject({ PATH: '/bin', ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'grunt-local', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder:30b', ANTHROPIC_SMALL_FAST_MODEL: 'qwen3-coder:30b' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(buildChildEnv({}, conn('http://h'), 'secret', 'm').ANTHROPIC_AUTH_TOKEN).toBe('secret');
  });
});
