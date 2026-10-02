import { describe, expect, it } from 'vitest';
import { FakeChatEngine } from '@grunt/core/testing/fakes.js';
import type { Connection } from '@grunt/core/types/config.js';
import { endpointModelLister, RoutingChatEngine } from '../src/engine-router.js';

const conn = (kind: Connection['kind'], baseUrl: string | null = null): Connection => ({ id: 'c', name: 'n', kind, baseUrl, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });

describe('RoutingChatEngine', () => {
  it('routes claude_code to the Claude Code engine and everything else to the AI SDK engine', async () => {
    const aisdk = new FakeChatEngine([{ type: 'text-delta', text: 'aisdk' }]);
    const cc = new FakeChatEngine([{ type: 'text-delta', text: 'cc' }]);
    aisdk.models = [{ modelId: 'a', displayName: 'a', contextWindow: null, supportsVision: null, supportsTools: null }];
    cc.models = [{ modelId: 'sonnet', displayName: 'Sonnet', contextWindow: null, supportsVision: true, supportsTools: true }];
    const router = new RoutingChatEngine(aisdk, cc);
    expect((await router.listModels(conn('claude_code'), null))[0]!.modelId).toBe('sonnet');
    expect((await router.listModels(conn('ollama'), null))[0]!.modelId).toBe('a');
  });
  it('lists endpoint models through the Ollama path with /v1 appended', async () => {
    const aisdk = new FakeChatEngine([]);
    const seen: Connection[] = [];
    aisdk.listModels = async (c) => { seen.push(c); return []; };
    await endpointModelLister(aisdk)(conn('claude_code', 'http://localhost:11434/'), null);
    expect(seen[0]).toMatchObject({ kind: 'ollama', baseUrl: 'http://localhost:11434/v1' });
  });
});
