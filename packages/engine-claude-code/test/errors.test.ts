import { describe, expect, it } from 'vitest';
import { classifyClaudeCodeFailure, isMissingSessionError } from '../src/errors.js';

const c = { backend: 'claude', modelId: 'sonnet' };
describe('classifyClaudeCodeFailure', () => {
  it.each([
    ['Invalid API key · Please run /login', 'auth', false],
    ['Claude AI usage limit reached|1700000000', 'rate_limit', true],
    ['API Error: 429 rate_limit_error', 'rate_limit', true],
    ['model qwen9 not found', 'model_not_found', false],
    ['registry.ollama.ai/library/qwen2.5-coder:3b-base does not support tools', 'capability', false],
    ['something odd happened', 'unknown', false],
  ])('%s -> %s', (text, kind, retryable) => {
    expect(classifyClaudeCodeFailure(text, c)).toMatchObject({ kind, retryable });
  });
  it('names the endpoint when it is unreachable', () => {
    expect(classifyClaudeCodeFailure('fetch failed: connect ECONNREFUSED 127.0.0.1:11434', { backend: 'http://localhost:11434', modelId: 'q' })).toEqual({ kind: 'transient', retryable: true, message: "Can't reach http://localhost:11434." });
  });
  it('uses a rejected rate-limit event even when the text is vague', () => {
    expect(classifyClaudeCodeFailure('error', { ...c, rateLimitResetsAt: 1700000000 })).toMatchObject({ kind: 'rate_limit', message: expect.stringContaining('resets') });
  });
  it('gives the login hint for auth failures', () => {
    expect(classifyClaudeCodeFailure('not logged in', c).message).toBe("Claude Code isn't logged in. Run `claude` and `/login`.");
  });
  it('blames the endpoint, not the Claude login, for an endpoint backend auth failure', () => {
    expect(classifyClaudeCodeFailure('API Error: 401 Unauthorized', { backend: 'http://localhost:11434', modelId: 'q' })).toEqual({ kind: 'auth', retryable: false, message: 'http://localhost:11434 rejected the token.' });
    expect(classifyClaudeCodeFailure('Invalid API key · Please run /login', { backend: 'http://gw.example', modelId: 'q' }).message).not.toMatch(/login/);
  });
  it('detects a missing session on resume', () => {
    expect(isMissingSessionError('No conversation found with session ID: abc')).toBe(true);
    expect(isMissingSessionError('other')).toBe(false);
  });
});
