import { describe, it, expect } from 'vitest';
import type { Connection, ConnectionKind } from '@grunt/core/types/config.js';
import { ProviderRegistry, ConfigError } from '../src/registry.js';

let counter = 0;
function makeConnection(overrides: Partial<Connection> = {}): Connection {
  counter += 1;
  return {
    id: `conn-${counter}`,
    name: `Test Connection ${counter}`,
    kind: 'anthropic',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
    ...overrides,
  };
}

const AI_SDK_KINDS: ConnectionKind[] = ['anthropic', 'openai', 'google'];

describe('ProviderRegistry', () => {
  it.each(AI_SDK_KINDS)('constructs an AI SDK provider for kind %s', (kind) => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind });
    const handle = registry.resolve(connection, 'sk-test-key');
    expect(handle.kind).toBe('aisdk');
  });

  it('constructs an openai_compatible provider when a base URL is set', () => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind: 'openai_compatible', baseUrl: 'https://example.com/v1' });
    const handle = registry.resolve(connection, 'key');
    expect(handle.kind).toBe('aisdk');
  });

  it('throws a ConfigError for openai_compatible without a base URL', () => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind: 'openai_compatible', baseUrl: null });
    expect(() => registry.resolve(connection, 'key')).toThrow(ConfigError);
    expect(() => registry.resolve(connection, 'key')).toThrow(/base ?url/i);
  });

  it('constructs an ollama provider using the OpenAI-compatible surface', () => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind: 'ollama', baseUrl: null });
    const handle = registry.resolve(connection, null);
    expect(handle.kind).toBe('aisdk');
  });

  it('does not require a base URL for ollama (defaults to the local server)', () => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind: 'ollama', baseUrl: null });
    expect(() => registry.resolve(connection, null)).not.toThrow();
  });

  it('resolves a mock handle for kind mock, requiring no key', () => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind: 'mock', baseUrl: null });
    const handle = registry.resolve(connection, null);
    expect(handle.kind).toBe('mock');
  });

  it('caches the provider instance for unchanged credentials', () => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind: 'anthropic' });
    const first = registry.resolve(connection, 'sk-key');
    const second = registry.resolve(connection, 'sk-key');
    expect(second).toBe(first);
  });

  it('editing the API key produces a new provider instance', () => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind: 'anthropic' });
    const first = registry.resolve(connection, 'sk-key-one');
    const second = registry.resolve(connection, 'sk-key-two');
    expect(second).not.toBe(first);
  });

  it('editing the base URL produces a new provider instance', () => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind: 'openai_compatible', baseUrl: 'https://a.example.com/v1' });
    const first = registry.resolve(connection, 'key');
    const updated = { ...connection, baseUrl: 'https://b.example.com/v1' };
    const second = registry.resolve(updated, 'key');
    expect(second).not.toBe(first);
  });

  it('editing extraHeaders produces a new provider instance', () => {
    const registry = new ProviderRegistry();
    const connection = makeConnection({ kind: 'anthropic', extraHeaders: { 'X-A': '1' } });
    const first = registry.resolve(connection, 'key');
    const updated = { ...connection, extraHeaders: { 'X-A': '2' } };
    const second = registry.resolve(updated, 'key');
    expect(second).not.toBe(first);
  });
});
