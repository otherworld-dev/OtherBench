import { describe, it, expect } from 'vitest';
import { FakeChatEngine, InMemoryStore } from '../src/testing/fakes.js';
import { TurnRunner, type TurnEvent } from '../src/domain/turn.js';
import type { ToolApprovalEvent, ToolProvider } from '../src/ports/tool-provider.js';

describe('TurnRunner progress relay', () => {
  it('relays a progress ToolApprovalEvent as tool-progress with its message id', () => {
    let fire: ((e: ToolApprovalEvent) => void) | null = null;
    const provider = {
      onApprovalEvent(cb: (e: ToolApprovalEvent) => void) {
        fire = cb;
        return () => {};
      },
    } as unknown as ToolProvider;
    const runner = new TurnRunner(new InMemoryStore(), new FakeChatEngine([]), { toolProvider: provider });
    const seen: TurnEvent[] = [];
    runner.on((e) => seen.push(e));
    fire!({ type: 'progress', messageId: 'm1', callId: 'call-1', progress: { stage: 'generating', step: 3, steps: 20 } });
    expect(seen).toEqual([{ messageId: 'm1', type: 'tool-progress', callId: 'call-1', progress: { stage: 'generating', step: 3, steps: 20 } }]);
  });
});
