import { describe, expect, it } from 'vitest';
import type { Connection } from '@otherbench/core/types/config.js';
import { MAIN_ACCOUNT, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import { backendOf, buildChildEnv } from '../src/env.js';

const conn = (baseUrl: string | null): Connection => ({ id: 'c', name: 'CC', kind: 'claude_code', baseUrl, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });

const VH: ClaudeAccountRef = { slug: 'vh', name: 'VH', configDir: 'C:\\x\\.claude-vh' };

describe('env', () => {
  it('names the backend', () => {
    expect(backendOf(conn(null))).toBe('claude');
    expect(backendOf(conn('http://localhost:11434/'))).toBe('http://localhost:11434');
  });
  it('strips API credentials in any case for the Claude login', () => {
    const env = buildChildEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k', anthropic_auth_token: 't', Anthropic_Base_Url: 'x' }, conn(null), null, 'sonnet');
    // The server's own API token never reaches Claude Code or its Bash, in any letter case.
    for (const name of ['OTHERBENCH_TOKEN', 'otherbench_token']) {
      expect(Object.keys(buildChildEnv({ PATH: '/bin', [name]: 'secret' }, conn(null), null, 'sonnet'))).not.toContain(name);
    }
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' });
  });
  it.each([null, 'http://localhost:11434'])('drops parent Claude Code session variables in any case (base URL %s)', (baseUrl) => {
    const env = buildChildEnv({ PATH: '/bin', CLAUDECODE: '1', claude_code_entrypoint: 'cli', Claude_Code_SSE_Port: '1234', CLAUDE_CONFIG_DIR: '/cfg' }, conn(baseUrl), null, 'm');
    for (const k of Object.keys(env)) expect(k).not.toMatch(/^(claudecode|claude_code_entrypoint|claude_code_sse_port)$/i);
    expect(env).toMatchObject({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg' });
  });
  it("never lets an extra folder's CLAUDE.md load, whatever OtherBench's own environment says", () => {
    const env = buildChildEnv({ PATH: '/bin', claude_code_additional_directories_claude_md: '1' }, conn(null), null, 'sonnet');
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' });
  });
  it('points Claude Code at an endpoint with a token and the chosen model for background calls', () => {
    const env = buildChildEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'k' }, conn('http://localhost:11434/'), null, 'qwen3-coder:30b');
    expect(env).toMatchObject({ PATH: '/bin', ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'otherbench-local', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder:30b', ANTHROPIC_SMALL_FAST_MODEL: 'qwen3-coder:30b' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(buildChildEnv({}, conn('http://h'), 'secret', 'm').ANTHROPIC_AUTH_TOKEN).toBe('secret');
  });
  it("never lets Claude Code move a long tool call to the background, whatever OtherBench's own environment says", () => {
    for (const b of [null, 'http://h']) {
      const env = buildChildEnv({ PATH: '/bin', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '30000', claude_code_mcp_auto_background_ms: '5000' }, conn(b), null, 'm');
      expect(Object.keys(env).filter((k) => /^claude_code_mcp_auto_background_ms$/i.test(k))).toEqual(['CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS']);
      expect(env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS).toBe('0');
    }
  });
  it('turns the todo tools on for every model and backend', () => {
    for (const b of [null, 'http://h']) expect(buildChildEnv({}, conn(b), null, 'm').CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');
  });
  it("points Claude Code at an account's own config folder, replacing an inherited one in any letter case", () => {
    const env = buildChildEnv({ PATH: '/bin', claude_config_dir: 'C:\\other', Claude_Config_Dir: 'C:\\other2' }, conn(null), null, 'm', VH);
    expect(Object.keys(env).filter((k) => /^claude_config_dir$/i.test(k))).toEqual(['CLAUDE_CONFIG_DIR']);
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:\\x\\.claude-vh');
  });
  it('ignores the account for an endpoint backend, which uses no Claude login (its backend names no account either)', () => {
    const env = buildChildEnv({ PATH: '/bin', claude_config_dir: '/cfg' }, conn('http://h'), null, 'm', VH);
    expect(env['claude_config_dir']).toBe('/cfg');
    expect(env['CLAUDE_CONFIG_DIR']).toBeUndefined();
  });
  it('passes an inherited CLAUDE_CONFIG_DIR through unchanged for main, or no account', () => {
    for (const account of [MAIN_ACCOUNT, undefined]) {
      const env = buildChildEnv({ PATH: '/bin', claude_config_dir: '/cfg' }, conn(null), null, 'm', account);
      expect(env).toEqual({ PATH: '/bin', claude_config_dir: '/cfg', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0' });
    }
  });
  it("names an account's backend after its slug, and an endpoint after its URL whatever the account", () => {
    expect(backendOf(conn(null), VH)).toBe('claude:vh');
    expect(backendOf(conn(null), MAIN_ACCOUNT)).toBe('claude');
    expect(backendOf(conn('http://localhost:11434/'), VH)).toBe('http://localhost:11434');
  });
});
