import { describe, expect, it } from 'vitest';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import { changedFiles } from './changedFiles.js';

const msg = (id: string, parentId: string | null, parts: Part[], createdAt = 1): CanonMessage => ({
  id, chatId: 'c1', parentId, role: 'assistant', parts, status: 'complete', error: null, producedBy: null, createdAt,
});
const call = (id: string, name: string, args: unknown): Part => ({ type: 'tool-call', id, name, args });
const ok = (id: string, name: string): Part => ({ type: 'tool-result', id, name, result: 'ok', isError: false });
const failed = (id: string, name: string): Part => ({ type: 'tool-result', id, name, result: 'no match', isError: true });

describe('changedFiles', () => {
  it('sums edits to one file across branches, and counts a Write', () => {
    const messages = [
      msg('u1', null, [{ type: 'text', text: 'go' }]),
      // Two replies to the same user message: a branch each.
      msg('a1', 'u1', [call('t1', 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }), ok('t1', 'Edit')], 2),
      msg('a2', 'u1', [
        call('t2', 'Edit', { file_path: 'a.ts', old_string: 'p\nq', new_string: 'r' }), ok('t2', 'Edit'),
        call('t3', 'Write', { file_path: 'b.ts', content: 'one\ntwo\nthree' }), ok('t3', 'Write'),
      ], 3),
    ];
    const files = changedFiles(messages);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(files[0]).toMatchObject({ path: 'a.ts', added: 2, removed: 3 });
    expect(files[0]!.edits).toHaveLength(2);
    expect(files[1]).toMatchObject({ path: 'b.ts', added: 3, removed: 0 });
  });

  it('leaves out an edit whose result is an error, and one with no result yet', () => {
    const messages = [
      msg('a1', null, [
        call('t1', 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }), failed('t1', 'Edit'),
        call('t2', 'edit_file', { path: 'c.ts', oldString: 'x', newString: 'y' }),
      ]),
    ];
    expect(changedFiles(messages)).toEqual([]);
  });

  it('ignores a Read call', () => {
    const messages = [msg('a1', null, [call('t1', 'Read', { file_path: 'a.ts' }), ok('t1', 'Read')])];
    expect(changedFiles(messages)).toEqual([]);
  });

  it("counts a sub-agent's own edits", () => {
    const sub: Part = {
      type: 'subagent', callId: 'task-1', label: 'Fix it', prompt: 'p', profileId: 'p', profileName: 'Claude', modelId: 'm', status: 'complete',
      parts: [call('s1', 'Write', { file_path: 'd.ts', content: 'x' }), ok('s1', 'Write')],
    };
    const files = changedFiles([msg('a1', null, [sub])]);
    expect(files).toMatchObject([{ path: 'd.ts', added: 1, removed: 0 }]);
  });

  it('groups a path under the app folder with its relative form when given the root', () => {
    const messages = [
      msg('a1', null, [
        call('t1', 'Write', { file_path: 'E:\\Git\\App\\src\\a.ts', content: 'x' }), ok('t1', 'Write'),
        call('t2', 'write_file', { path: 'src/a.ts', content: 'y\nz' }), ok('t2', 'write_file'),
      ]),
    ];
    const files = changedFiles(messages, 'E:\\Git\\App');
    expect(files).toMatchObject([{ path: 'src/a.ts', added: 3 }]);
  });
});
