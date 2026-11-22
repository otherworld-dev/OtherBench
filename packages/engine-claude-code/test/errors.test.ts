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
    expect(overloaded).toMatchObject({ kind: 'rate_limit', message: 'Claude is overloaded right now. Try again in a moment.' });
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
    expect(classifyClaudeCodeFailure('not logged in', { backend: 'claude:vh', modelId: 'sonnet' }).message).toBe("This Claude account isn't signed in. Sign in under Settings → Claude accounts.");
    expect(classifyClaudeCodeFailure('not logged in', { backend: 'claude', modelId: 'sonnet' }).message).toBe("Claude Code isn't logged in. Run `claude` and `/login`.");
    expect(classifyClaudeCodeFailure('fetch failed: connect ECONNREFUSED 127.0.0.1:443', { backend: 'claude:vh', modelId: 'sonnet' }).kind).toBe('unknown');
  });
  it('detects a missing session on resume', () => {
    expect(isMissingSessionError('No conversation found with session ID: abc')).toBe(true);
    expect(isMissingSessionError('other')).toBe(false);
  });
});

describe('classifyClaudeCodeFailure: structure before wording', () => {
  const DIED = 'Claude Code process exited with code 1';

  it.each([
    // An MCP server's own trouble on stderr is not Claude Code's login.
    ['an MCP server failing to authenticate', ['[mcp:github] authentication failed: 401 Unauthorized'], 'unknown'],
    ['an MCP server naming a login page', ['[mcp:deck] open https://cloud.example/login to sign in'], 'unknown'],
    ['an MCP server with a bad key of its own', ['[mcp:search] Invalid API key for search.example'], 'unknown'],
    ['an MCP server reporting a 404 or a 429', ['[mcp:wiki] GET /page 404', '[mcp:wiki] 429 rate limit, backing off'], 'unknown'],
    ['an MCP server that could not connect', ['[mcp:local] fetch failed: connect ECONNREFUSED 127.0.0.1:9000'], 'unknown'],
    // Claude Code's own lines still count wherever they arrive.
    ["Claude Code's own login line", ['Invalid API key · Please run /login'], 'auth'],
    ["Claude Code's own API error line", ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'], 'auth'],
    ["Claude Code's own limit line", ['Claude AI usage limit reached|1700000000'], 'rate_limit'],
  ])('with %s on stderr', (_name, stderr, kind) => {
    expect(classifyClaudeCodeFailure(DIED, { ...c, stderr }).kind).toBe(kind);
    expect(classifyClaudeCodeFailure(DIED, { backend: 'http://localhost:11434', modelId: 'q', stderr }).kind).toBe(kind);
  });

  it('keeps the stderr in an unknown failure, so the reason can still be read', () => {
    expect(classifyClaudeCodeFailure(DIED, { ...c, stderr: ['[mcp:github] authentication failed'] }).message).toBe(`${DIED}
[mcp:github] authentication failed`);
  });

  it.each([
    ['MCP server "github" requires authentication', 'unknown'],
    ['Tool mcp__web__fetch failed: the request took 401 ms', 'unknown'],
    ['See https://example.com/login for details', 'unknown'],
    ['not logged in', 'auth'],
    ['Invalid API key · Please run /login', 'auth'],
    ['API Error: 401 Unauthorized', 'auth'],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'auth'],
  ])('reads "%s" as %s', (text, kind) => {
    expect(classifyClaudeCodeFailure(text, c).kind).toBe(kind);
  });

  it.each([
    // [text, what the SDK said, kind, retryable, message]
    ['API Error: 529 overloaded_error', {}, 'rate_limit', true, /overloaded/i],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {}, 'rate_limit', true, /overloaded/i],
    ['Overloaded', { apiError: 'overloaded' }, 'rate_limit', true, /overloaded/i],
    ['error', { apiStatus: 529 }, 'rate_limit', true, /overloaded/i],
    ['API Error: 429 rate_limit_error', {}, 'rate_limit', true, /rate limited/i],
    ['API Error: 429 Too Many Requests', {}, 'rate_limit', true, /rate limited/i],
    ['Claude AI usage limit reached|1700000000', {}, 'rate_limit', true, /usage limit reached/i],
    ["You've hit your limit · resets 3pm", {}, 'rate_limit', true, /usage limit reached/i],
    // The status decides, whatever the words beside it say.
    ['API Error: 500 authentication service unavailable', {}, 'transient', true, /try again/i],
    ['API Error: 503 too many requests, overloaded', {}, 'transient', true, /try again/i],
    ['the model said: not logged in', { apiStatus: 500 }, 'transient', true, /try again/i],
    ['error', { apiError: 'server_error' }, 'transient', true, /try again/i],
    ['error', { apiStatus: 401 }, 'auth', false, /logged in/i],
    ['error', { apiError: 'authentication_failed' }, 'auth', false, /logged in/i],
    ['API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}', {}, 'model_not_found', false, /Model not found/],
    ['error', { apiError: 'model_not_found' }, 'model_not_found', false, /Model not found/],
  ])('%s %j -> %s', (text, said, kind, retryable, message) => {
    expect(classifyClaudeCodeFailure(text, { ...c, ...said })).toMatchObject({ kind, retryable, message: expect.stringMatching(message) });
  });

  it('never calls an overload or a bare 429 a usage limit', () => {
    for (const text of ['API Error: 529 overloaded_error', 'API Error: 429 rate_limit_error']) {
      const error = classifyClaudeCodeFailure(text, c);
      expect(error.message).not.toMatch(/usage limit/i);
      expect(error.detail).not.toHaveProperty('usageLimit');
    }
    // Real evidence of a limit still wins over an overload's wording.
    expect(classifyClaudeCodeFailure('API Error: 529 overloaded_error', { ...c, rateLimited: true })).toMatchObject({ message: 'Claude usage limit reached.', detail: { usageLimit: true } });
  });

  it('names the endpoint, not Claude, when an endpoint is overloaded', () => {
    expect(classifyClaudeCodeFailure('API Error: 529 overloaded_error', { backend: 'http://localhost:11434', modelId: 'q' }).message).toBe('http://localhost:11434 is overloaded right now. Try again in a moment.');
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
