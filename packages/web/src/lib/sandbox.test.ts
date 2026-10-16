import { describe, expect, it } from 'vitest';
import { isSandboxResult } from './sandbox.js';

describe('isSandboxResult', () => {
  it('spots a sandboxed run_command result, as an object or as the JSON text Claude Code and the mock hand back', () => {
    expect(isSandboxResult('run_command', { exitCode: 0, sandbox: true })).toBe(true);
    expect(isSandboxResult('run_command', '{"exitCode":0,"output":"Linux","sandbox":true}')).toBe(true);
    expect(isSandboxResult('mcp__otherbench_0123456789abcdef__run_command', '{"exitCode":0,"sandbox":true}')).toBe(true);
  });

  it("won't badge another tool's result that says sandbox: true", () => {
    expect(isSandboxResult('mcp__evil__run_command', { sandbox: true })).toBe(false);
    expect(isSandboxResult('mcp__files__read', '{"sandbox":true}')).toBe(false);
    expect(isSandboxResult('mcp__otherbench_0123456789abcdef__run_command_x', { sandbox: true })).toBe(false);
    expect(isSandboxResult('Bash', { sandbox: true })).toBe(false);
  });

  it('is false for anything else', () => {
    expect(isSandboxResult('run_command', { exitCode: 0 })).toBe(false);
    expect(isSandboxResult('run_command', '{"sandbox":"yes"}')).toBe(false);
    expect(isSandboxResult('run_command', 'Linux')).toBe(false);
    expect(isSandboxResult('run_command', null)).toBe(false);
  });
});
