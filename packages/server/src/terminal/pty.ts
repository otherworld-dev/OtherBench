/** A pseudo-terminal running one program, as the terminal manager uses it (spec 2026-10-21-code-terminal-design). */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Starts `file` with `args` in a PTY; the folder is its working directory, never part of a command line. */
export type PtySpawn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => PtyProcess;
