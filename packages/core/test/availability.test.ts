import { describe, expect, it } from 'vitest';
import { availableOn, defaultAvailability, isLoopbackUrl } from '../src/domain/availability.js';

describe('connection availability', () => {
  it.each([
    ['http://localhost:11434', true],
    ['http://127.0.0.1:8080/v1', true],
    ['http://127.4.5.6', true],
    ['http://[::1]:11434', true],
    ['https://api.anthropic.com', false],
    ['http://192.168.1.20:11434', false],
    ['http://localhost.example.com', false],
    ['not a url', false],
  ])('%s is loopback: %s', (url, loopback) => {
    expect(isLoopbackUrl(url)).toBe(loopback);
  });

  it('a loopback connection, or Ollama on its default address, is bound to this machine; anything else works anywhere', () => {
    expect(defaultAvailability('openai_compatible', 'http://localhost:1234/v1', 'pc')).toBe('pc');
    expect(defaultAvailability('ollama', null, 'pc')).toBe('pc');
    expect(defaultAvailability('ollama', 'http://192.168.1.20:11434', 'pc')).toBe('anywhere');
    expect(defaultAvailability('anthropic', null, 'pc')).toBe('anywhere');
  });

  it('is usable anywhere, or only on the machine it is bound to', () => {
    expect(availableOn({ availability: 'anywhere' }, 'laptop')).toBe(true);
    expect(availableOn({}, 'laptop')).toBe(true);
    expect(availableOn({ availability: 'pc' }, 'pc')).toBe(true);
    expect(availableOn({ availability: 'pc' }, 'laptop')).toBe(false);
  });
});
