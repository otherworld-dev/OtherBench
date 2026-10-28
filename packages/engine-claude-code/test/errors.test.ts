import { describe, expect, it } from 'vitest';
import { AUTO_MODE_UNAVAILABLE_MESSAGE, classifyClaudeCodeFailure, isMissingSessionError } from '../src/errors.js';

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
  it('puts the reset time on a rate limit in ms, only when it is known', () => {
    expect(classifyClaudeCodeFailure('error', { ...c, rateLimitResetsAt: 1700000000 }).detail).toEqual({ text: 'error', resetsAt: 1_700_000_000_000, usageLimit: true });
    expect(classifyClaudeCodeFailure('Claude AI usage limit reached|1700000123', c).detail).toEqual({ text: 'Claude AI usage limit reached|1700000123', resetsAt: 1_700_000_123_000, usageLimit: true });
    expect(classifyClaudeCodeFailure("You've hit your limit", c).detail).toEqual({ text: "You've hit your limit", usageLimit: true });
  });
  it('marks a usage limit only on real evidence, never on an overload or a bare 429', () => {
    const overloaded = classifyClaudeCodeFailure('API Error: 529 overloaded_error', c);
    expect(overloaded).toMatchObject({ kind: 'rate_limit', message: 'Claude usage limit reached.' });
    expect(overloaded.detail).toEqual({ text: 'API Error: 529 overloaded_error' });
    expect(classifyClaudeCodeFailure('API Error: 429 Too Many Requests', c).detail).toEqual({ text: 'API Error: 429 Too Many Requests' });
    expect(classifyClaudeCodeFailure('API Error: 429 rate_limit_error', c).detail).not.toHaveProperty('usageLimit');

    expect(classifyClaudeCodeFailure('Claude AI usage limit reached', c).detail).toMatchObject({ usageLimit: true });
    expect(classifyClaudeCodeFailure("You've hit your usage limit · resets 3pm", c).detail).toMatchObject({ usageLimit: true });
    expect(classifyClaudeCodeFailure('error', { ...c, rateLimitResetsAt: 1700000000 }).detail).toMatchObject({ usageLimit: true });
    // A rejected rate-limit event (or Claude Code's own limit message) with no reset time.
    const flagged = classifyClaudeCodeFailure('error', { ...c, rateLimited: true });
    expect(flagged.kind).toBe('rate_limit');
    expect(flagged.detail).toEqual({ text: 'error', usageLimit: true });
  });
  it('gives the login hint for auth failures', () => {
    expect(classifyClaudeCodeFailure('not logged in', c).message).toBe("Claude Code isn't logged in. Run `claude` and `/login`.");
  });
  it('blames the endpoint, not the Claude login, for an endpoint backend auth failure', () => {
    expect(classifyClaudeCodeFailure('API Error: 401 Unauthorized', { backend: 'http://localhost:11434', modelId: 'q' })).toEqual({ kind: 'auth', retryable: false, message: 'http://localhost:11434 rejected the token.' });
    expect(classifyClaudeCodeFailure('Invalid API key · Please run /login', { backend: 'http://gw.example', modelId: 'q' }).message).not.toMatch(/login/);
  });
  it("classifies the CLI's own limit text", () => {
    expect(classifyClaudeCodeFailure("You've hit your limit · resets 3pm", { backend: 'claude', modelId: 'x' }).kind).toBe('rate_limit');
    expect(classifyClaudeCodeFailure("You've hit your usage limit", { backend: 'claude:vh', modelId: 'x' }).kind).toBe('rate_limit');
  });
  it("gives the login hint, not the endpoint's, for another account's auth failure", () => {
    expect(classifyClaudeCodeFailure('not logged in', { backend: 'claude:vh', modelId: 'sonnet' }).message).toBe("Claude Code isn't logged in. Run `claude` and `/login`.");
    expect(classifyClaudeCodeFailure('fetch failed: connect ECONNREFUSED 127.0.0.1:443', { backend: 'claude:vh', modelId: 'sonnet' }).kind).toBe('unknown');
  });
  it('detects a missing session on resume', () => {
    expect(isMissingSessionError('No conversation found with session ID: abc')).toBe(true);
    expect(isMissingSessionError('other')).toBe(false);
  });
});

describe('auto mode unavailable', () => {
  it.each([
    'Auto mode is not available for this model',
    'auto mode unavailable for this account',
    'Cannot start in auto-mode: auto mode is disabled by your organization',
  ])('maps "%s" to the capability error', (text) => {
    expect(classifyClaudeCodeFailure(text, { backend: 'claude', modelId: 'sonnet', autoMode: true })).toEqual({ kind: 'capability', retryable: false, message: AUTO_MODE_UNAVAILABLE_MESSAGE });
  });
  it('does not apply to a turn that is not in auto mode', () => {
    const text = 'Auto mode is not available for this model';
    expect(classifyClaudeCodeFailure(text, { backend: 'claude', modelId: 'sonnet' }).kind).toBe('unknown');
    expect(classifyClaudeCodeFailure(text, { backend: 'claude', modelId: 'sonnet', autoMode: false }).kind).toBe('unknown');
  });
  it('does not misread an unrelated failure', () => {
    expect(classifyClaudeCodeFailure('Tool Bash failed: exit 1', { backend: 'claude', modelId: 'sonnet' }).kind).toBe('unknown');
  });
});
