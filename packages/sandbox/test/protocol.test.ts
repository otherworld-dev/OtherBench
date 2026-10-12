import { describe, expect, it } from 'vitest';
import { parseAgentMessage } from '../src/protocol.js';

describe('parseAgentMessage', () => {
  it('reads every message the agent sends', () => {
    expect(parseAgentMessage('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseAgentMessage('{"type":"fatal","message":"no bwrap"}')).toEqual({ type: 'fatal', message: 'no bwrap' });
    expect(parseAgentMessage('{"type":"failed","id":2,"message":"bad"}')).toEqual({ type: 'failed', id: 2, message: 'bad' });
    expect(parseAgentMessage('{"type":"ask","askId":1,"host":"pypi.org","port":null}')).toEqual({ type: 'ask', askId: 1, host: 'pypi.org', port: null });
    expect(parseAgentMessage('{"type":"done","id":1,"exitCode":null,"signal":"SIGTERM","timedOut":false,"truncated":false,"note":""}')).toEqual({
      type: 'done',
      id: 1,
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: false,
      truncated: false,
      note: '',
    });
  });

  it('refuses what is not exactly a message', () => {
    for (const line of [
      '',
      'null',
      '[]',
      '{"type":"nope"}',
      '{"type":"output","id":1.5,"chunk":"x"}',
      '{"type":"output","id":9007199254740993,"chunk":"x"}',
      '{"type":"output","id":1,"chunk":5}',
      '{"type":"done","id":1,"exitCode":"0","signal":null,"timedOut":false,"truncated":false,"note":""}',
      '{"type":"done","id":1,"exitCode":0,"signal":null,"timedOut":"no","truncated":false,"note":""}',
      '{"type":"ask","askId":1,"host":"x","port":"443"}',
    ]) {
      expect(parseAgentMessage(line), line).toBeNull();
    }
  });
});
