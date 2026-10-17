import { describe, expect, it } from 'vitest';
import type { EngineBackgroundEvent } from '@otherbench/core/ports/chat-engine.js';
import { BackgroundTasks } from '../src/background.js';

const system = (subtype: string, fields: object) => ({ type: 'system', subtype, uuid: 'u', session_id: 's', ...fields });
const assistant = (content: object[], parent: string | null) => ({ type: 'assistant', message: { content }, parent_tool_use_id: parent, uuid: 'u', session_id: 's' });

function make() {
  const events: EngineBackgroundEvent[] = [];
  let clock = 1000;
  const tasks = new BackgroundTasks('chat-1', (e) => events.push(e), () => clock);
  const helpers = () => (events.filter((e) => e.type === 'helpers').at(-1) as Extract<EngineBackgroundEvent, { type: 'helpers' }> | undefined)?.helpers;
  const cardEvents = () => events.filter((e): e is Extract<EngineBackgroundEvent, { type: 'helper-event' }> => e.type === 'helper-event');
  return { tasks, events, helpers, cardEvents, tick: (ms: number) => (clock += ms) };
}

describe('BackgroundTasks', () => {
  it('tracks the live set from background_tasks_changed, leaving ambient tasks out', () => {
    const { tasks, helpers } = make();
    tasks.handle(system('background_tasks_changed', { tasks: [
      { task_id: 'k1', task_type: 'local_agent', description: 'implementer' },
      { task_id: 'k2', task_type: 'local_bash', description: 'npm run dev' },
      { task_id: 'k3', task_type: 'local_agent', description: 'watcher', ambient: true },
    ] }));
    expect(helpers()).toEqual([
      { taskId: 'k1', callId: null, kind: 'local_agent', label: 'implementer', startedAt: 1000, lastActivity: null },
      { taskId: 'k2', callId: null, kind: 'local_bash', label: 'npm run dev', startedAt: 1000, lastActivity: null },
    ]);
    expect(tasks.running).toBe(true);
    tasks.handle(system('background_tasks_changed', { tasks: [] }));
    expect(helpers()).toEqual([]);
    expect(tasks.running).toBe(false);
  });

  it('records the last tool and progress summary, and which helper made each tool call', () => {
    const { tasks, helpers } = make();
    tasks.noteCard('t1', 'm1');
    tasks.handle(system('task_started', { task_id: 'k1', tool_use_id: 't1', description: 'implementer', task_type: 'local_agent', is_backgrounded: true }));
    tasks.handle(assistant([{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test' } }], 't1'));
    expect(helpers()?.[0]).toMatchObject({ taskId: 'k1', callId: 't1', lastActivity: 'Bash' });
    expect(tasks.ownerOf('c1')).toEqual({ callId: 't1', label: 'implementer', messageId: 'm1' });
    expect(tasks.ownerOf('unknown')).toBeNull();
    tasks.handle(system('task_progress', { task_id: 'k1', description: 'implementer', last_tool_name: 'Edit', summary: 'Fixing the sha check' }));
    expect(helpers()?.[0]).toMatchObject({ lastActivity: 'Fixing the sha check' });
  });

  it('ends the card in its earlier reply when the helper finishes, with its report', () => {
    const { tasks, helpers, cardEvents, tick } = make();
    tasks.noteCard('t1', 'm1');
    tasks.handle(system('task_started', { task_id: 'k1', tool_use_id: 't1', description: 'implementer', is_backgrounded: true }));
    tick(5000);
    tasks.handle(system('task_notification', { task_id: 'k1', status: 'completed', summary: 'Done: sha check fixed.', output_file: '' }));
    expect(cardEvents()).toEqual([
      { type: 'helper-event', chatId: 'chat-1', messageId: 'm1', callId: 't1', event: { type: 'text-delta', text: 'Done: sha check fixed.' } },
      { type: 'helper-event', chatId: 'chat-1', messageId: 'm1', callId: 't1', event: { type: 'end', status: 'complete', at: 6000 } },
    ]);
    expect(helpers()).toEqual([]);
  });

  it("leaves the card of the reply that's running to that reply", () => {
    const { tasks, cardEvents } = make();
    tasks.noteCard('t1', 'm1');
    tasks.current = 'm1';
    tasks.handle(system('task_started', { task_id: 'k1', tool_use_id: 't1', description: 'implementer' }));
    tasks.handle(system('task_notification', { task_id: 'k1', status: 'failed', summary: 'Crashed', output_file: '' }));
    expect(cardEvents()).toEqual([]);
  });

  it('puts a resumed helper back in the background', () => {
    const { tasks, cardEvents } = make();
    tasks.noteCard('t1', 'm1');
    tasks.handle(system('task_started', { task_id: 'k1', tool_use_id: 't1', description: 'implementer', is_backgrounded: true }));
    tasks.handle(system('task_notification', { task_id: 'k1', status: 'completed', summary: '', output_file: '' }));
    // SendMessage resumes it: same task id, started again.
    tasks.handle(system('task_started', { task_id: 'k1', tool_use_id: 'send-1', description: 'implementer', is_backgrounded: true }));
    expect(cardEvents().at(-1)).toEqual({ type: 'helper-event', chatId: 'chat-1', messageId: 'm1', callId: 't1', event: { type: 'background', at: 1000 } });
  });

  it('close ends every helper as stopped', () => {
    const { tasks, helpers, cardEvents } = make();
    tasks.noteCard('t1', 'm1');
    tasks.handle(system('task_started', { task_id: 'k1', tool_use_id: 't1', description: 'implementer', is_backgrounded: true }));
    tasks.closeAll();
    expect(cardEvents().at(-1)).toMatchObject({ messageId: 'm1', callId: 't1', event: { type: 'end', status: 'cancelled' } });
    expect(helpers()).toEqual([]);
    expect(tasks.running).toBe(false);
  });
});
