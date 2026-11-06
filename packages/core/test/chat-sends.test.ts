import { describe, expect, it } from 'vitest';
import { REPLY_MAX_CHARS, cutReply, deliveredText, isSettled, repliesText } from '../src/domain/chat-sends.js';

describe('chat-to-chat text', () => {
  it('deliveredText names the sending chat, says its agent sent it, and keeps the body verbatim', () => {
    const text = deliveredText({ title: 'API work', chatId: 'chat-a', appName: 'Server' }, 'Add a /health route.\nThanks');
    const [first, ...rest] = text.split('\n');
    expect(first).toContain('"API work"');
    expect(first).toContain('chat-a');
    expect(first).toContain('Server');
    expect(text).toMatch(/agent/);
    expect(text).toMatch(/not typed by the user|didn't type/);
    expect(text).toMatch(/final reply goes back/);
    expect(text.endsWith('\n\nAdd a /health route.\nThanks')).toBe(true);
    expect(rest.length).toBeGreaterThan(1);
  });

  it('deliveredText leaves the app out for a chat in no app', () => {
    expect(deliveredText({ title: 'Loose', chatId: 'c1', appName: null }, 'x').split('\n')[0]).not.toContain('app');
  });

  it('repliesText lists each chat with its status, text or reason, and points at recall', () => {
    const text = repliesText([
      { title: 'Web', chatId: 'chat-b', status: 'replied', text: 'Done: added the button.', reason: null },
      { title: 'Server', chatId: 'chat-c', status: 'failed', text: null, reason: 'The folder is not on this machine.' },
    ]);
    expect(text).toContain('## Web (chat chat-b)');
    expect(text).toContain('Done: added the button.');
    expect(text).toContain('## Server (chat chat-c)');
    expect(text).toContain('failed');
    expect(text).toContain('The folder is not on this machine.');
    expect(text.indexOf('chat-b')).toBeLessThan(text.indexOf('chat-c'));
    expect(text).toMatch(/recall/);
  });

  it('cutReply cuts a long reply and says so, and leaves a short one alone', () => {
    const cut = cutReply('x'.repeat(REPLY_MAX_CHARS + 1));
    expect(cut.length).toBeLessThan(REPLY_MAX_CHARS + 200);
    expect(cut.startsWith('x'.repeat(REPLY_MAX_CHARS))).toBe(true);
    expect(cut).toMatch(/cut/);
    expect(cutReply('short')).toBe('short');
  });

  it('isSettled is false only while queued or running', () => {
    expect(isSettled('queued')).toBe(false);
    expect(isSettled('running')).toBe(false);
    for (const s of ['replied', 'failed', 'stopped', 'dropped'] as const) expect(isSettled(s)).toBe(true);
  });
});
