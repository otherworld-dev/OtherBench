import { describe, expect, it } from 'vitest';
import { isSandboxResult } from './sandbox.js';

describe('isSandboxResult', () => {
  it('spots a sandboxed run_command result, as an object or as the JSON text Claude Code and the mock hand back', () => {
    expect(isSandboxResult({ exitCode: 0, sandbox: true })).toBe(true);
    expect(isSandboxResult('{"exitCode":0,"output":"Linux","sandbox":true}')).toBe(true);
  });

  it('is false for anything else', () => {
    expect(isSandboxResult({ exitCode: 0 })).toBe(false);
    expect(isSandboxResult('{"sandbox":"yes"}')).toBe(false);
    expect(isSandboxResult('Linux')).toBe(false);
    expect(isSandboxResult(null)).toBe(false);
  });
});
