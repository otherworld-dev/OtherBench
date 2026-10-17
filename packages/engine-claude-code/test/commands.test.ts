import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { chatCommands } from '../src/commands.js';

const row = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({ name, description: `${name} d`, argumentHint: '', ...extra });

describe('chatCommands', () => {
  it('keeps user and plugin commands and the allowed built-ins, dropping the rest and the ones OtherBench owns', () => {
    const rows = [
      row('deploy'),
      row('init', { builtin: true }),
      row('config', { builtin: true }),
      row('clear', { builtin: true, aliases: ['reset', 'new'] }),
      row('compact-notes'),
      row('code-review', { builtin: true, aliases: ['review'] }),
      row('wipe', { builtin: true, aliases: ['new'] }),
    ];
    expect(chatCommands(rows).map((r) => r.name)).toEqual(['compact-notes', 'deploy', 'code-review', 'init']);
  });

  it('maps absent aliases to an empty list', () => {
    expect(chatCommands([row('deploy')])).toEqual([{ name: 'deploy', description: 'deploy d', argumentHint: '', aliases: [] }]);
  });
});
