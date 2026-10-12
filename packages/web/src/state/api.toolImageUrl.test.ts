import { describe, expect, it } from 'vitest';
import { api } from './api';
import { apiUrl } from './transport';

describe('api.attachments.toolImageUrl', () => {
  it('names the chat, the reply and the file, in the scoped route', () => {
    expect(api.attachments.toolImageUrl('chat-1', 'msg-2', 'att-3')).toBe(apiUrl('/chats/chat-1/messages/msg-2/tool-images/att-3'));
  });

  it('keeps an id from changing the path it is in', () => {
    const url = api.attachments.toolImageUrl('a/../b', 'm?x=1', 'f#g');
    expect(url).toBe(apiUrl('/chats/a%2F..%2Fb/messages/m%3Fx%3D1/tool-images/f%23g'));
    expect(url).not.toContain('/../');
  });

  it('is not the id-only content route', () => {
    expect(api.attachments.toolImageUrl('c', 'm', 'a')).not.toBe(api.attachments.contentUrl('a'));
  });
});
