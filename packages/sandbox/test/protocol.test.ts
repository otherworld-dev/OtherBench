import { describe, expect, it } from 'vitest';
import { parseAgentMessage } from '../src/protocol.js';

describe('parseAgentMessage', () => {
  it('reads every message the agent sends', () => {
    expect(parseAgentMessage('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(parseAgentMessage('{"type":"fatal","message":"no bwrap"}')).toEqual({ type: 'fatal', message: 'no bwrap' });
    expect(parseAgentMessage('{"type":"failed","id":2,"message":"bad","unguarded":["/mnt/e/ws"]}')).toEqual({ type: 'failed', id: 2, message: 'bad', unguarded: ['/mnt/e/ws'] });
    expect(parseAgentMessage('{"type":"restoring","id":3}')).toEqual({ type: 'restoring', id: 3 });
    expect(parseAgentMessage('{"type":"ask","askId":1,"host":"pypi.org","port":null}')).toEqual({ type: 'ask', askId: 1, host: 'pypi.org', port: null });
    expect(parseAgentMessage('{"type":"done","id":1,"exitCode":null,"signal":"SIGTERM","timedOut":false,"truncated":false,"note":"","unguarded":[]}')).toEqual({
      type: 'done',
      id: 1,
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: false,
      truncated: false,
      note: '',
      unguarded: [],
    });
  });

  it('reads a done or failed without unguarded (an older agent) as none', () => {
    expect(parseAgentMessage('{"type":"failed","id":2,"message":"bad"}')).toEqual({ type: 'failed', id: 2, message: 'bad', unguarded: [] });
    expect(parseAgentMessage('{"type":"done","id":1,"exitCode":0,"signal":null,"timedOut":false,"truncated":false,"note":""}')).toMatchObject({ unguarded: [] });
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
      '{"type":"done","id":1,"exitCode":0,"signal":null,"timedOut":false,"truncated":false,"note":"","unguarded":"/mnt/e/ws"}',
      '{"type":"failed","id":1,"message":"x","unguarded":[1]}',
      '{"type":"restoring","id":"1"}',
      '{"type":"ask","askId":1,"host":"x","port":"443"}',
    ]) {
      expect(parseAgentMessage(line), line).toBeNull();
    }
  });
});
